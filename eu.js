const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const cron = require('node-cron'); // ✅ ADICIONADO PARA CRON JOBS
const app = express();
const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET || 'seu_segredo_jwt_super_seguro_aqui';
const uploadRouter = require('./upload');
const prisma = new PrismaClient({
  log: ['query', 'error', 'warn'],
  transactionOptions: {
    maxWait: 10000,
    timeout: 30000,
  }
});

// ==============================================
// 1. MIDDLEWARE
// ==============================================

app.use(cors({
  origin: "*"
}));

app.use(express.json({ limit: '10mb' }));

// Middleware de logs
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Middleware de autenticação JWT
const authenticateToken = async (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token de acesso necessário'
            });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        
        const user = await prisma.user.findUnique({
            where: { id: decoded.userId },
            select: { id: true, mobile: true }
        });

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        req.user = user;
        next();
    } catch (error) {
        console.error('Erro na autenticação:', error);
        
        if (error.name === 'JsonWebTokenError') {
            return res.status(403).json({
                success: false,
                message: 'Token inválido'
            });
        }
        
        if (error.name === 'TokenExpiredError') {
            return res.status(403).json({
                success: false,
                message: 'Token expirado'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Erro na autenticação'
        });
    }
};

// ==============================================
// 2. SISTEMA DE RENDIMENTOS AUTOMÁTICOS
// ==============================================

// Middleware para chamadas do sistema
const authenticateSystem = (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token de sistema necessário'
            });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Verificar se é um token de sistema
        if (decoded.system !== true) {
            return res.status(403).json({
                success: false,
                message: 'Token de sistema inválido'
            });
        }

        next();
    } catch (error) {
        console.error('Erro na autenticação do sistema:', error);
        res.status(403).json({
            success: false,
            message: 'Token de sistema inválido'
        });
    }
};

// ROTA PRINCIPAL PARA PROCESSAMENTO AUTOMÁTICO
app.post('/api/process-daily-payouts', authenticateSystem, async (req, res) => {
    try {
        const now = new Date();
        console.log(`🚀 ${now.toISOString()} - INICIANDO PROCESSAMENTO AUTOMÁTICO DE RENDIMENTOS`);
        
        // Buscar todas as compras ativas com next_payout vencido
        const duePurchases = await prisma.purchase.findMany({
            where: {
                status: 'active',
                next_payout: {
                    lte: now
                },
                expiry_date: {
                    gt: now
                }
            },
            include: {
                user: {
                    select: {
                        id: true,
                        mobile: true,
                        saldo: true
                    }
                }
            }
        });

        console.log(`📊 Encontradas ${duePurchases.length} compras para processar`);

        if (duePurchases.length === 0) {
            console.log('ℹ️ Nenhum rendimento para processar hoje');
            return res.json({
                success: true,
                message: 'Nenhum rendimento para processar hoje',
                data: {
                    processed: 0,
                    total_amount: 0,
                    timestamp: now.toISOString()
                }
            });
        }

        let processedCount = 0;
        let totalAmount = 0;
        const results = [];
        const errors = [];

        // Processar cada compra
        for (const purchase of duePurchases) {
            try {
                console.log(`🔄 Processando compra ${purchase.id} para usuário ${purchase.user.mobile}`);
                
                // Calcular próximo payout (24 horas depois)
                const nextPayout = new Date(purchase.next_payout);
                nextPayout.setHours(nextPayout.getHours() + 24);

                // Verificar se atingiu o ciclo máximo
                const daysPassed = Math.floor((now - purchase.purchase_date) / (1000 * 60 * 60 * 24));
                const remainingDays = (purchase.cycle_days || 30) - daysPassed;

                if (remainingDays <= 0) {
                    // Finalizar produto
                    await prisma.purchase.update({
                        where: { id: purchase.id },
                        data: {
                            status: 'completed',
                            completed_at: new Date()
                        }
                    });

                    results.push({
                        purchase_id: purchase.id,
                        user_id: purchase.user_id,
                        user_mobile: purchase.user.mobile,
                        status: 'completed',
                        message: 'Produto completou o ciclo'
                    });
                    continue;
                }

                // Valor do rendimento diário
                const dailyReturn = purchase.daily_return || 13;

                // Processar transação
                await prisma.$transaction(async (tx) => {
                    // 1. Adicionar saldo ao usuário
                    const updatedUser = await tx.user.update({
                        where: { id: purchase.user_id },
                        data: {
                            saldo: {
                                increment: dailyReturn
                            }
                        },
                        select: {
                            saldo: true
                        }
                    });

                    console.log(`✅ Saldo atualizado: ${purchase.user.mobile} = ${updatedUser.saldo} KZ (+${dailyReturn} KZ)`);

                    // 2. Atualizar compra
                    await tx.purchase.update({
                        where: { id: purchase.id },
                        data: {
                            next_payout: nextPayout,
                            total_earned: {
                                increment: dailyReturn
                            },
                            payout_count: {
                                increment: 1
                            },
                            last_payout: new Date()
                        }
                    });

                    // 3. Registrar transação
                    await tx.transaction.create({
                        data: {
                            user_id: purchase.user_id,
                            type: 'daily_payout_auto',
                            amount: dailyReturn,
                            description: `Rendimento automático: ${purchase.product_name}`,
                            balance_after: updatedUser.saldo,
                            created_at: new Date()
                        }
                    });

                    // 4. Registrar log do sistema
                    await tx.systemLog.create({
                        data: {
                            action: 'AUTO_DAILY_PAYOUT',
                            description: `Rendimento automático de ${dailyReturn} KZ para ${purchase.user.mobile}. Produto: ${purchase.product_name}`,
                            user_id: purchase.user_id,
                            created_at: new Date()
                        }
                    });
                });

                processedCount++;
                totalAmount += dailyReturn;
                results.push({
                    purchase_id: purchase.id,
                    user_id: purchase.user_id,
                    user_mobile: purchase.user.mobile,
                    amount: dailyReturn,
                    next_payout: nextPayout,
                    status: 'success'
                });

                console.log(`✅ Rendimento processado: +${dailyReturn} KZ para ${purchase.user.mobile}`);

            } catch (purchaseError) {
                console.error(`❌ Erro processando compra ${purchase.id}:`, purchaseError);
                errors.push({
                    purchase_id: purchase.id,
                    user_id: purchase.user_id,
                    error: purchaseError.message
                });
            }
        }

        console.log(`🎉 PROCESSAMENTO CONCLUÍDO: ${processedCount} rendimentos, total: ${totalAmount} KZ`);

        // Registrar log geral
        await prisma.systemLog.create({
            data: {
                action: 'AUTO_PAYOUTS_COMPLETED',
                description: `Processamento automático concluído: ${processedCount} rendimentos processados, total: ${totalAmount} KZ. Erros: ${errors.length}`,
                created_at: new Date()
            }
        });

        res.json({
            success: true,
            message: `Processamento automático concluído: ${processedCount} rendimentos, total: ${totalAmount} KZ`,
            data: {
                processed: processedCount,
                total_amount: totalAmount,
                timestamp: now.toISOString(),
                results: results,
                errors: errors,
                summary: {
                    success: results.length,
                    failed: errors.length,
                    total_processed: duePurchases.length
                }
            }
        });

    } catch (error) {
        console.error('❌ ERRO NO PROCESSAMENTO AUTOMÁTICO:', error);
        
        await prisma.systemLog.create({
            data: {
                action: 'AUTO_PAYOUTS_ERROR',
                description: `Erro no processamento automático: ${error.message}`,
                created_at: new Date()
            }
        });

        res.status(500).json({
            success: false,
            message: 'Erro no processamento automático',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// ==============================================
// 3. CRON JOB PARA RENDER.COM
// ==============================================

// Função para executar o processamento
async function executeAutoPayouts() {
    try {
        console.log('⏰ Cron job executando processamento de rendimentos...');
        
        const token = jwt.sign({ system: true }, JWT_SECRET);
        
        // Usando fetch nativo do Node.js 18+
        const response = await fetch(`http://localhost:${PORT}/api/process-daily-payouts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        });
        
        const result = await response.json();
        console.log('📊 Resultado do cron job:', result.message);
        
        return result;
    } catch (error) {
        console.error('❌ Erro no cron job:', error);
        return { success: false, error: error.message };
    }
}

// Configurar cron job para rodar todos os dias às 00:00 (meia-noite)
if (process.env.NODE_ENV === 'production') {
    // Agendar para rodar todos os dias à meia-noite
    cron.schedule('0 0 * * *', async () => {
        console.log('🕛 Cron job acionado (meia-noite)');
        await executeAutoPayouts();
    }, {
        timezone: "Africa/Luanda" // Fuso horário de Angola
    });
    
    console.log('✅ Cron job configurado para rodar diariamente às 00:00');
}

// Rota para testar manualmente o cron job
app.post('/api/test-auto-payouts', authenticateSystem, async (req, res) => {
    try {
        console.log('🧪 Teste manual de processamento de rendimentos');
        const result = await executeAutoPayouts();
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ==============================================
// 4. ROTAS ADMIN PARA CONTROLE
// ==============================================

app.get('/api/system/payouts-status', authenticateToken, async (req, res) => {
    try {
        const now = new Date();
        
        // Verificar se é admin (simplificado)
        if (req.user.id !== 'admin') {
            return res.status(403).json({
                success: false,
                message: 'Acesso negado'
            });
        }

        // Contar rendimentos pendentes para hoje
        const pendingCount = await prisma.purchase.count({
            where: {
                status: 'active',
                next_payout: {
                    lte: now
                },
                expiry_date: {
                    gt: now
                }
            }
        });

        // Últimas execuções
        const lastLogs = await prisma.systemLog.findMany({
            where: {
                action: {
                    in: ['AUTO_DAILY_PAYOUT', 'AUTO_PAYOUTS_COMPLETED']
                }
            },
            orderBy: { created_at: 'desc' },
            take: 5
        });

        // Estatísticas
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const todayPayouts = await prisma.transaction.count({
            where: {
                type: 'daily_payout_auto',
                created_at: {
                    gte: today
                }
            }
        });

        const totalPayouts = await prisma.transaction.count({
            where: { type: 'daily_payout_auto' }
        });

        const totalAmount = await prisma.transaction.aggregate({
            where: { type: 'daily_payout_auto' },
            _sum: { amount: true }
        });

        res.json({
            success: true,
            data: {
                system: 'active',
                cron_job_active: true,
                pending_today: pendingCount,
                statistics: {
                    today_payouts: todayPayouts,
                    total_payouts: totalPayouts,
                    total_amount: totalAmount._sum.amount || 0
                },
                next_run: '00:00 (todos os dias)',
                timezone: 'Africa/Luanda',
                recent_activity: lastLogs.map(log => ({
                    time: log.created_at,
                    action: log.action,
                    description: log.description
                }))
            }
        });

    } catch (error) {
        console.error('Erro ao verificar status:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao verificar status'
        });
    }
});

// ==============================================
// 5. ATUALIZAR ROTAS EXISTENTES PARA SISTEMA AUTOMÁTICO
// ==============================================

// Rota de compras do usuário - ATUALIZADA
app.get('/api/user/purchases', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const purchases = await prisma.purchase.findMany({
            where: {
                user_id: userId
            },
            orderBy: {
                purchase_date: 'desc'
            }
        });

        // Formatar resposta PARA SISTEMA AUTOMÁTICO
        const formattedPurchases = purchases.map(purchase => {
            const today = new Date();
            const expiryDate = new Date(purchase.expiry_date);
            const nextPayout = new Date(purchase.next_payout);
            
            // Calcular dias restantes
            const daysRemaining = Math.max(0, Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24)));
            
            // Calcular progresso
            const progress = purchase.payout_count > 0 
                ? Math.min(100, Math.round((purchase.payout_count / purchase.cycle_days) * 100))
                : 0;

            // Status de display
            let displayStatus = purchase.status;
            let statusMessage = '';
            
            if (purchase.status === 'active') {
                if (daysRemaining <= 0) {
                    displayStatus = 'expired';
                    statusMessage = 'Produto expirado';
                } else if (nextPayout <= today) {
                    statusMessage = 'Rendimento pendente (sistema automático)';
                } else {
                    const nextPayoutStr = nextPayout.toLocaleTimeString('pt-AO', { 
                        hour: '2-digit', 
                        minute: '2-digit' 
                    });
                    statusMessage = `Próximo rendimento: ${nextPayoutStr}`;
                }
            }

            return {
                id: purchase.id,
                product_id: purchase.product_id,
                product_name: purchase.product_name || 'Produto',
                amount: purchase.amount,
                daily_return: purchase.daily_return,
                total_return: purchase.daily_return * purchase.cycle_days,
                total_earned: purchase.total_earned || 0,
                quantity: purchase.quantity,
                status: displayStatus,
                status_message: statusMessage,
                purchase_date: purchase.purchase_date,
                expiry_date: purchase.expiry_date,
                next_payout: purchase.next_payout,
                cycle_days: purchase.cycle_days,
                days_remaining: daysRemaining,
                payout_count: purchase.payout_count || 0,
                last_payout: purchase.last_payout,
                progress_percentage: progress,
                payout_system: 'automático',
                info: 'Rendimentos são creditados automaticamente todos os dias'
            };
        });

        res.json({
            success: true,
            data: formattedPurchases
        });

    } catch (error) {
        console.error('Erro ao buscar compras:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar seus pacotes'
        });
    }
});

// Rota de estatísticas - ATUALIZADA
app.get('/api/user/packages-stats', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        const purchases = await prisma.purchase.findMany({
            where: {
                user_id: userId
            }
        });

        // Filtros
        const today = new Date();
        const activePurchases = purchases.filter(p => {
            const expiryDate = new Date(p.expiry_date);
            return p.status === 'active' && expiryDate > today;
        });

        // Cálculos
        const totalPackages = purchases.length;
        const activePackages = activePurchases.length;
        const completedPackages = purchases.filter(p => p.status === 'completed').length;
        
        const dailyIncome = activePurchases.reduce((sum, p) => sum + (p.daily_return || 0), 0);
        const totalEarned = purchases.reduce((sum, p) => sum + (p.total_earned || 0), 0);
        const totalInvested = purchases.reduce((sum, p) => sum + (p.amount || 0), 0);
        const netProfit = totalEarned - totalInvested;

        // Próximo rendimento
        const nextPayout = activePurchases.length > 0
            ? activePurchases.reduce((earliest, p) => 
                new Date(p.next_payout) < new Date(earliest.next_payout) ? p : earliest
              )
            : null;

        res.json({
            success: true,
            data: {
                total_packages: totalPackages,
                active_packages: activePackages,
                completed_packages: completedPackages,
                daily_income: dailyIncome,
                total_earned: totalEarned,
                total_invested: totalInvested,
                net_profit: netProfit,
                next_auto_payout: nextPayout ? {
                    time: nextPayout.next_payout,
                    product: nextPayout.product_name,
                    amount: nextPayout.daily_return
                } : null,
                payout_system: {
                    type: 'automático',
                    description: 'Rendimentos creditados automaticamente todos os dias',
                    schedule: 'Diariamente às 00:00',
                    timezone: 'Africa/Luanda'
                }
            }
        });

    } catch (error) {
        console.error('Erro ao buscar estatísticas:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar estatísticas'
        });
    }
});

// ==============================================
// 6. REMOVER ROTAS DE COLETA MANUAL (OPCIONAL)
// ==============================================

// Comente ou remova estas rotas se não quiser coleta manual:
/*
app.post('/api/tasks/collect-product-income', authenticateToken, async (req, res) => {
    // Remover ou desativar
    res.status(410).json({
        success: false,
        message: 'Coleta manual desativada. Sistema agora é automático.'
    });
});

app.post('/api/tasks/collect-all-income', authenticateToken, async (req, res) => {
    // Remover ou desativar
    res.status(410).json({
        success: false,
        message: 'Coleta manual desativada. Sistema agora é automático.'
    });
});
*/

// ==============================================
// 7. CONFIGURAÇÃO DO RENDER.COM
// ==============================================

// Rota para verificar se o sistema está rodando
app.get('/api/system/health', async (req, res) => {
    res.json({
        success: true,
        data: {
            service: 'Auto Payout System',
            status: 'operational',
            timestamp: new Date().toISOString(),
            version: '2.0.0',
            features: [
                'daily_auto_payouts',
                'cron_job_scheduler',
                'automatic_expiry',
                'real_time_logging'
            ]
        }
    });
});

// ==============================================
// 8. CONFIGURAR CRON JOB NO RENDER.COM
// ==============================================

// Instruções para configurar no Render.com:

/*
1. Acesse seu dashboard no Render.com
2. Vá para seu serviço Web Service
3. Clique em "Cron Jobs"
4. Adicione um novo Cron Job:

- Schedule: "0 0 * * *" (todos os dias à meia-noite)
- Timezone: Africa/Luanda
- Command: 
  curl -X POST https://bd-p4q7.onrender.com/api/process-daily-payouts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(echo -n 'seu_segredo_jwt_super_seguro_aqui' | base64)"

5. Salve e ative

OU use a interface web do Render:

- Path: /api/process-daily-payouts
- Schedule: 0 0 * * *
- HTTP Method: POST
- Headers:
  Content-Type: application/json
  Authorization: Bearer seu_token_sistema_aqui
*/

// ==============================================
// 9. INICIAR SERVIDOR
// ==============================================

// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`🌐 URL: https://bd-p4q7.onrender.com`);
    console.log(`🏥 Health check: https://bd-p4q7.onrender.com/health`);
    console.log(`🤖 Auto-payouts: https://bd-p4q7.onrender.com/api/process-daily-payouts`);
    console.log(`⏰ Cron job: 00:00 todos os dias (Africa/Luanda)`);
    
    // Conectar ao banco
    prisma.$connect()
        .then(() => {
            console.log('✅ Conectado ao banco de dados');
            console.log('✅ Sistema de rendimentos automáticos PRONTO');
            
            // Executar teste inicial
            if (process.env.NODE_ENV !== 'production') {
                setTimeout(async () => {
                    console.log('🧪 Executando teste inicial do sistema...');
                    try {
                        const token = jwt.sign({ system: true }, JWT_SECRET);
                        // Teste omitido em produção
                    } catch (error) {
                        console.log('ℹ️ Teste inicial não executado em produção');
                    }
                }, 2000);
            }
        })
        .catch(err => {
            console.error('❌ Erro na conexão com o banco:', err);
            process.exit(1);
        });
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('🛑 Desligando servidor...');
    await prisma.$disconnect();
    console.log('✅ Servidor desligado');
    process.exit(0);
});
    } catch (error) {
        console.error('Erro na autenticação:', error);
        
        if (error.name === 'JsonWebTokenError') {
            return res.status(403).json({
                success: false,
                message: 'Token inválido'
            });
        }
        
        if (error.name === 'TokenExpiredError') {
            return res.status(403).json({
                success: false,
                message: 'Token expirado'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Erro na autenticação'
        });
    }
};

// ==============================================
// 2. SISTEMA DE RENDIMENTOS AUTOMÁTICOS
// ==============================================

// Middleware para chamadas do sistema
const authenticateSystem = (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token de sistema necessário'
            });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Verificar se é um token de sistema
        if (decoded.system !== true) {
            return res.status(403).json({
                success: false,
                message: 'Token de sistema inválido'
            });
        }

        next();
    } catch (error) {
        console.error('Erro na autenticação do sistema:', error);
        res.status(403).json({
            success: false,
            message: 'Token de sistema inválido'
        });
    }
};

// ROTA PRINCIPAL PARA PROCESSAMENTO AUTOMÁTICO
app.post('/api/process-daily-payouts', authenticateSystem, async (req, res) => {
    try {
        const now = new Date();
        console.log(`🚀 ${now.toISOString()} - INICIANDO PROCESSAMENTO AUTOMÁTICO DE RENDIMENTOS`);
        
        // Buscar todas as compras ativas com next_payout vencido
        const duePurchases = await prisma.purchase.findMany({
            where: {
                status: 'active',
                next_payout: {
                    lte: now
                },
                expiry_date: {
                    gt: now
                }
            },
            include: {
                user: {
                    select: {
                        id: true,
                        mobile: true,
                        saldo: true
                    }
                }
            }
        });

        console.log(`📊 Encontradas ${duePurchases.length} compras para processar`);

        if (duePurchases.length === 0) {
            console.log('ℹ️ Nenhum rendimento para processar hoje');
            return res.json({
                success: true,
                message: 'Nenhum rendimento para processar hoje',
                data: {
                    processed: 0,
                    total_amount: 0,
                    timestamp: now.toISOString()
                }
            });
        }

        let processedCount = 0;
        let totalAmount = 0;
        const results = [];
        const errors = [];

        // Processar cada compra
        for (const purchase of duePurchases) {
            try {
                console.log(`🔄 Processando compra ${purchase.id} para usuário ${purchase.user.mobile}`);
                
                // Calcular próximo payout (24 horas depois)
                const nextPayout = new Date(purchase.next_payout);
                nextPayout.setHours(nextPayout.getHours() + 24);

                // Verificar se atingiu o ciclo máximo
                const daysPassed = Math.floor((now - purchase.purchase_date) / (1000 * 60 * 60 * 24));
                const remainingDays = (purchase.cycle_days || 30) - daysPassed;

                if (remainingDays <= 0) {
                    // Finalizar produto
                    await prisma.purchase.update({
                        where: { id: purchase.id },
                        data: {
                            status: 'completed',
                            completed_at: new Date()
                        }
                    });

                    results.push({
                        purchase_id: purchase.id,
                        user_id: purchase.user_id,
                        user_mobile: purchase.user.mobile,
                        status: 'completed',
                        message: 'Produto completou o ciclo'
                    });
                    continue;
                }

                // Valor do rendimento diário
                const dailyReturn = purchase.daily_return || 13;

                // Processar transação
                await prisma.$transaction(async (tx) => {
                    // 1. Adicionar saldo ao usuário
                    const updatedUser = await tx.user.update({
                        where: { id: purchase.user_id },
                        data: {
                            saldo: {
                                increment: dailyReturn
                            }
                        },
                        select: {
                            saldo: true
                        }
                    });

                    console.log(`✅ Saldo atualizado: ${purchase.user.mobile} = ${updatedUser.saldo} KZ (+${dailyReturn} KZ)`);

                    // 2. Atualizar compra
                    await tx.purchase.update({
                        where: { id: purchase.id },
                        data: {
                            next_payout: nextPayout,
                            total_earned: {
                                increment: dailyReturn
                            },
                            payout_count: {
                                increment: 1
                            },
                            last_payout: new Date()
                        }
                    });

                    // 3. Registrar transação
                    await tx.transaction.create({
                        data: {
                            user_id: purchase.user_id,
                            type: 'daily_payout_auto',
                            amount: dailyReturn,
                            description: `Rendimento automático: ${purchase.product_name}`,
                            balance_after: updatedUser.saldo,
                            created_at: new Date()
                        }
                    });

                    // 4. Registrar log do sistema
                    await tx.systemLog.create({
                        data: {
                            action: 'AUTO_DAILY_PAYOUT',
                            description: `Rendimento automático de ${dailyReturn} KZ para ${purchase.user.mobile}. Produto: ${purchase.product_name}`,
                            user_id: purchase.user_id,
                            created_at: new Date()
                        }
                    });
                });

                processedCount++;
                totalAmount += dailyReturn;
                results.push({
                    purchase_id: purchase.id,
                    user_id: purchase.user_id,
                    user_mobile: purchase.user.mobile,
                    amount: dailyReturn,
                    next_payout: nextPayout,
                    status: 'success'
                });

                console.log(`✅ Rendimento processado: +${dailyReturn} KZ para ${purchase.user.mobile}`);

            } catch (purchaseError) {
                console.error(`❌ Erro processando compra ${purchase.id}:`, purchaseError);
                errors.push({
                    purchase_id: purchase.id,
                    user_id: purchase.user_id,
                    error: purchaseError.message
                });
            }
        }

        console.log(`🎉 PROCESSAMENTO CONCLUÍDO: ${processedCount} rendimentos, total: ${totalAmount} KZ`);

        // Registrar log geral
        await prisma.systemLog.create({
            data: {
                action: 'AUTO_PAYOUTS_COMPLETED',
                description: `Processamento automático concluído: ${processedCount} rendimentos processados, total: ${totalAmount} KZ. Erros: ${errors.length}`,
                created_at: new Date()
            }
        });

        res.json({
            success: true,
            message: `Processamento automático concluído: ${processedCount} rendimentos, total: ${totalAmount} KZ`,
            data: {
                processed: processedCount,
                total_amount: totalAmount,
                timestamp: now.toISOString(),
                results: results,
                errors: errors,
                summary: {
                    success: results.length,
                    failed: errors.length,
                    total_processed: duePurchases.length
                }
            }
        });

    } catch (error) {
        console.error('❌ ERRO NO PROCESSAMENTO AUTOMÁTICO:', error);
        
        await prisma.systemLog.create({
            data: {
                action: 'AUTO_PAYOUTS_ERROR',
                description: `Erro no processamento automático: ${error.message}`,
                created_at: new Date()
            }
        });

        res.status(500).json({
            success: false,
            message: 'Erro no processamento automático',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// ==============================================
// 3. CRON JOB PARA RENDER.COM
// ==============================================

// Função para executar o processamento
async function executeAutoPayouts() {
    try {
        console.log('⏰ Cron job executando processamento de rendimentos...');
        
        const token = jwt.sign({ system: true }, JWT_SECRET);
        
        // Usando fetch nativo do Node.js 18+
        const response = await fetch(`http://localhost:${PORT}/api/process-daily-payouts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        });
        
        const result = await response.json();
        console.log('📊 Resultado do cron job:', result.message);
        
        return result;
    } catch (error) {
        console.error('❌ Erro no cron job:', error);
        return { success: false, error: error.message };
    }
}

// Configurar cron job para rodar todos os dias às 00:00 (meia-noite)
if (process.env.NODE_ENV === 'production') {
    // Agendar para rodar todos os dias à meia-noite
    cron.schedule('0 0 * * *', async () => {
        console.log('🕛 Cron job acionado (meia-noite)');
        await executeAutoPayouts();
    }, {
        timezone: "Africa/Luanda" // Fuso horário de Angola
    });
    
    console.log('✅ Cron job configurado para rodar diariamente às 00:00');
}

// Rota para testar manualmente o cron job
app.post('/api/test-auto-payouts', authenticateSystem, async (req, res) => {
    try {
        console.log('🧪 Teste manual de processamento de rendimentos');
        const result = await executeAutoPayouts();
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ==============================================
// 4. ROTAS ADMIN PARA CONTROLE
// ==============================================

app.get('/api/system/payouts-status', authenticateToken, async (req, res) => {
    try {
        const now = new Date();
        
        // Verificar se é admin (simplificado)
        if (req.user.id !== 'admin') {
            return res.status(403).json({
                success: false,
                message: 'Acesso negado'
            });
        }

        // Contar rendimentos pendentes para hoje
        const pendingCount = await prisma.purchase.count({
            where: {
                status: 'active',
                next_payout: {
                    lte: now
                },
                expiry_date: {
                    gt: now
                }
            }
        });

        // Últimas execuções
        const lastLogs = await prisma.systemLog.findMany({
            where: {
                action: {
                    in: ['AUTO_DAILY_PAYOUT', 'AUTO_PAYOUTS_COMPLETED']
                }
            },
            orderBy: { created_at: 'desc' },
            take: 5
        });

        // Estatísticas
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const todayPayouts = await prisma.transaction.count({
            where: {
                type: 'daily_payout_auto',
                created_at: {
                    gte: today
                }
            }
        });

        const totalPayouts = await prisma.transaction.count({
            where: { type: 'daily_payout_auto' }
        });

        const totalAmount = await prisma.transaction.aggregate({
            where: { type: 'daily_payout_auto' },
            _sum: { amount: true }
        });

        res.json({
            success: true,
            data: {
                system: 'active',
                cron_job_active: true,
                pending_today: pendingCount,
                statistics: {
                    today_payouts: todayPayouts,
                    total_payouts: totalPayouts,
                    total_amount: totalAmount._sum.amount || 0
                },
                next_run: '00:00 (todos os dias)',
                timezone: 'Africa/Luanda',
                recent_activity: lastLogs.map(log => ({
                    time: log.created_at,
                    action: log.action,
                    description: log.description
                }))
            }
        });

    } catch (error) {
        console.error('Erro ao verificar status:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao verificar status'
        });
    }
});

// ==============================================
// 5. ATUALIZAR ROTAS EXISTENTES PARA SISTEMA AUTOMÁTICO
// ==============================================

// Rota de compras do usuário - ATUALIZADA
app.get('/api/user/purchases', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const purchases = await prisma.purchase.findMany({
            where: {
                user_id: userId
            },
            orderBy: {
                purchase_date: 'desc'
            }
        });

        // Formatar resposta PARA SISTEMA AUTOMÁTICO
        const formattedPurchases = purchases.map(purchase => {
            const today = new Date();
            const expiryDate = new Date(purchase.expiry_date);
            const nextPayout = new Date(purchase.next_payout);
            
            // Calcular dias restantes
            const daysRemaining = Math.max(0, Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24)));
            
            // Calcular progresso
            const progress = purchase.payout_count > 0 
                ? Math.min(100, Math.round((purchase.payout_count / purchase.cycle_days) * 100))
                : 0;

            // Status de display
            let displayStatus = purchase.status;
            let statusMessage = '';
            
            if (purchase.status === 'active') {
                if (daysRemaining <= 0) {
                    displayStatus = 'expired';
                    statusMessage = 'Produto expirado';
                } else if (nextPayout <= today) {
                    statusMessage = 'Rendimento pendente (sistema automático)';
                } else {
                    const nextPayoutStr = nextPayout.toLocaleTimeString('pt-AO', { 
                        hour: '2-digit', 
                        minute: '2-digit' 
                    });
                    statusMessage = `Próximo rendimento: ${nextPayoutStr}`;
                }
            }

            return {
                id: purchase.id,
                product_id: purchase.product_id,
                product_name: purchase.product_name || 'Produto',
                amount: purchase.amount,
                daily_return: purchase.daily_return,
                total_return: purchase.daily_return * purchase.cycle_days,
                total_earned: purchase.total_earned || 0,
                quantity: purchase.quantity,
                status: displayStatus,
                status_message: statusMessage,
                purchase_date: purchase.purchase_date,
                expiry_date: purchase.expiry_date,
                next_payout: purchase.next_payout,
                cycle_days: purchase.cycle_days,
                days_remaining: daysRemaining,
                payout_count: purchase.payout_count || 0,
                last_payout: purchase.last_payout,
                progress_percentage: progress,
                payout_system: 'automático',
                info: 'Rendimentos são creditados automaticamente todos os dias'
            };
        });

        res.json({
            success: true,
            data: formattedPurchases
        });

    } catch (error) {
        console.error('Erro ao buscar compras:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar seus pacotes'
        });
    }
});

// Rota de estatísticas - ATUALIZADA
app.get('/api/user/packages-stats', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        const purchases = await prisma.purchase.findMany({
            where: {
                user_id: userId
            }
        });

        // Filtros
        const today = new Date();
        const activePurchases = purchases.filter(p => {
            const expiryDate = new Date(p.expiry_date);
            return p.status === 'active' && expiryDate > today;
        });

        // Cálculos
        const totalPackages = purchases.length;
        const activePackages = activePurchases.length;
        const completedPackages = purchases.filter(p => p.status === 'completed').length;
        
        const dailyIncome = activePurchases.reduce((sum, p) => sum + (p.daily_return || 0), 0);
        const totalEarned = purchases.reduce((sum, p) => sum + (p.total_earned || 0), 0);
        const totalInvested = purchases.reduce((sum, p) => sum + (p.amount || 0), 0);
        const netProfit = totalEarned - totalInvested;

        // Próximo rendimento
        const nextPayout = activePurchases.length > 0
            ? activePurchases.reduce((earliest, p) => 
                new Date(p.next_payout) < new Date(earliest.next_payout) ? p : earliest
              )
            : null;

        res.json({
            success: true,
            data: {
                total_packages: totalPackages,
                active_packages: activePackages,
                completed_packages: completedPackages,
                daily_income: dailyIncome,
                total_earned: totalEarned,
                total_invested: totalInvested,
                net_profit: netProfit,
                next_auto_payout: nextPayout ? {
                    time: nextPayout.next_payout,
                    product: nextPayout.product_name,
                    amount: nextPayout.daily_return
                } : null,
                payout_system: {
                    type: 'automático',
                    description: 'Rendimentos creditados automaticamente todos os dias',
                    schedule: 'Diariamente às 00:00',
                    timezone: 'Africa/Luanda'
                }
            }
        });

    } catch (error) {
        console.error('Erro ao buscar estatísticas:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar estatísticas'
        });
    }
});

// ==============================================
// 6. REMOVER ROTAS DE COLETA MANUAL (OPCIONAL)
// ==============================================

// Comente ou remova estas rotas se não quiser coleta manual:
/*
app.post('/api/tasks/collect-product-income', authenticateToken, async (req, res) => {
    // Remover ou desativar
    res.status(410).json({
        success: false,
        message: 'Coleta manual desativada. Sistema agora é automático.'
    });
});

app.post('/api/tasks/collect-all-income', authenticateToken, async (req, res) => {
    // Remover ou desativar
    res.status(410).json({
        success: false,
        message: 'Coleta manual desativada. Sistema agora é automático.'
    });
});
*/

// ==============================================
// 7. CONFIGURAÇÃO DO RENDER.COM
// ==============================================

// Rota para verificar se o sistema está rodando
app.get('/api/system/health', async (req, res) => {
    res.json({
        success: true,
        data: {
            service: 'Auto Payout System',
            status: 'operational',
            timestamp: new Date().toISOString(),
            version: '2.0.0',
            features: [
                'daily_auto_payouts',
                'cron_job_scheduler',
                'automatic_expiry',
                'real_time_logging'
            ]
        }
    });
});

// ==============================================
// 8. CONFIGURAR CRON JOB NO RENDER.COM
// ==============================================

// Instruções para configurar no Render.com:

/*
1. Acesse seu dashboard no Render.com
2. Vá para seu serviço Web Service
3. Clique em "Cron Jobs"
4. Adicione um novo Cron Job:

- Schedule: "0 0 * * *" (todos os dias à meia-noite)
- Timezone: Africa/Luanda
- Command: 
  curl -X POST https://bd-p4q7.onrender.com/api/process-daily-payouts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(echo -n 'seu_segredo_jwt_super_seguro_aqui' | base64)"

5. Salve e ative

OU use a interface web do Render:

- Path: /api/process-daily-payouts
- Schedule: 0 0 * * *
- HTTP Method: POST
- Headers:
  Content-Type: application/json
  Authorization: Bearer seu_token_sistema_aqui
*/

// ==============================================
// 9. INICIAR SERVIDOR
// ==============================================

// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`🌐 URL: https://bd-p4q7.onrender.com`);
    console.log(`🏥 Health check: https://bd-p4q7.onrender.com/health`);
    console.log(`🤖 Auto-payouts: https://bd-p4q7.onrender.com/api/process-daily-payouts`);
    console.log(`⏰ Cron job: 00:00 todos os dias (Africa/Luanda)`);
    
    // Conectar ao banco
    prisma.$connect()
        .then(() => {
            console.log('✅ Conectado ao banco de dados');
            console.log('✅ Sistema de rendimentos automáticos PRONTO');
            
            // Executar teste inicial
            if (process.env.NODE_ENV !== 'production') {
                setTimeout(async () => {
                    console.log('🧪 Executando teste inicial do sistema...');
                    try {
                        const token = jwt.sign({ system: true }, JWT_SECRET);
                        // Teste omitido em produção
                    } catch (error) {
                        console.log('ℹ️ Teste inicial não executado em produção');
                    }
                }, 2000);
            }
        })
        .catch(err => {
            console.error('❌ Erro na conexão com o banco:', err);
            process.exit(1);
        });
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('🛑 Desligando servidor...');
    await prisma.$disconnect();
    console.log('✅ Servidor desligado');
    process.exit(0);
});
// ==============================================
// ADMIN ROUTES
// ==============================================

// Middleware de verificação de admin
const requireAdmin = (req, res, next) => {
    // Em produção, implemente uma verificação real de admin
    // Por enquanto, vamos usar um token simples
    const adminToken = req.headers['authorization']?.replace('Bearer ', '');
    
    if (adminToken === 'admin_secret_token_123') {
        next();
    } else {
        res.status(403).json({
            success: false,
            message: 'Acesso não autorizado. Token de administrador necessário.'
        });
    }
};

// Rota para admin - listar todos os usuários
app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            select: {
                id: true,
                mobile: true,
                saldo: true,
                invitation_code: true,
                created_at: true,
                _count: {
                    select: {
                        purchases: true,
                        referralLevels: true
                    }
                }
            },
            orderBy: { created_at: 'desc' }
        });

        const formattedUsers = users.map(user => ({
            id: user.id,
            mobile: user.mobile,
            saldo: user.saldo,
            invitation_code: user.invitation_code,
            created_at: user.created_at,
            purchase_count: user._count.purchases,
            referral_count: user._count.referralLevels
        }));

        const totalBalance = users.reduce((sum, user) => sum + (user.saldo || 0), 0);

        res.json({
            success: true,
            data: {
                users: formattedUsers,
                total: users.length,
                total_balance: totalBalance
            }
        });
    } catch (error) {
        console.error('Erro ao buscar usuários:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Erro interno do servidor' 
        });
    }
});

// Rota para admin - listar todos os depósitos
app.get('/api/admin/deposits', requireAdmin, async (req, res) => {
    try {
        const deposits = await prisma.deposit.findMany({
            include: {
                user: {
                    select: { 
                        id: true,
                        mobile: true 
                    }
                }
            },
            orderBy: { created_at: 'desc' }
        });

        const formattedDeposits = deposits.map(deposit => ({
            id: deposit.id,
            user_id: deposit.user_id,
            user_mobile: deposit.user.mobile,
            amount: deposit.amount,
            account_name: deposit.account_name,
            iban: deposit.iban,
            bank_name: deposit.bank_name,
            bank_code: deposit.bank_code,
            receipt_image: deposit.receipt_image,
            status: deposit.status,
            created_at: deposit.created_at,
            updated_at: deposit.updated_at,
            processed_at: deposit.processed_at
        }));

        res.json({
            success: true,
            data: formattedDeposits
        });
    } catch (error) {
        console.error('Erro ao buscar depósitos:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Erro interno do servidor' 
        });
    }
});

// Rota para admin - listar todos os saques
app.get('/api/admin/withdrawals', requireAdmin, async (req, res) => {
    try {
        const withdrawals = await prisma.withdrawal.findMany({
            include: {
                user: {
                    select: { 
                        id: true,
                        mobile: true 
                    }
                }
            },
            orderBy: { created_at: 'desc' }
        });

        const formattedWithdrawals = withdrawals.map(withdrawal => ({
            id: withdrawal.id,
            user_id: withdrawal.user_id,
            user_mobile: withdrawal.user.mobile,
            amount: withdrawal.amount,
            tax: withdrawal.tax,
            net_amount: withdrawal.net_amount,
            account_name: withdrawal.account_name,
            iban: withdrawal.iban,
            bank_name: withdrawal.bank_name,
            bank_code: withdrawal.bank_code,
            status: withdrawal.status,
            created_at: withdrawal.created_at,
            processed_at: withdrawal.processed_at
        }));

        res.json({
            success: true,
            data: formattedWithdrawals
        });
    } catch (error) {
        console.error('Erro ao buscar saques:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Erro interno do servidor' 
        });
    }
});

// Rota para admin - listar todas as transações
app.get('/api/admin/transactions', requireAdmin, async (req, res) => {
    try {
        const transactions = await prisma.transaction.findMany({
            include: {
                user: {
                    select: { 
                        id: true,
                        mobile: true 
                    }
                }
            },
            orderBy: { created_at: 'desc' },
            take: 200
        });

        const formattedTransactions = transactions.map(transaction => ({
            id: transaction.id,
            user_id: transaction.user_id,
            user_mobile: transaction.user.mobile,
            type: transaction.type,
            amount: transaction.amount,
            description: transaction.description,
            balance_after: transaction.balance_after,
            created_at: transaction.created_at
        }));

        res.json({
            success: true,
            data: formattedTransactions
        });
    } catch (error) {
        console.error('Erro ao buscar transações:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Erro interno do servidor' 
        });
    }
});

// Rota para admin - aprovar depósito (VERSÃO CORRIGIDA)
app.put('/api/admin/deposit/:id/approve', requireAdmin, async (req, res) => {
    let transaction;
    try {
        const { id } = req.params;
        
        console.log(`🔄 Iniciando aprovação do depósito: ${id}`);
        
        // Buscar o depósito
        const deposit = await prisma.deposit.findUnique({
            where: { id: id },
            include: {
                user: {
                    select: {
                        id: true,
                        mobile: true,
                        saldo: true
                    }
                }
            }
        });

        if (!deposit) {
            console.log(`❌ Depósito não encontrado: ${id}`);
            return res.status(404).json({
                success: false,
                message: 'Depósito não encontrado'
            });
        }

        if (deposit.status === 'completed') {
            console.log(`⚠️ Depósito já processado: ${id}`);
            return res.status(400).json({
                success: false,
                message: 'Depósito já foi processado'
            });
        }

        console.log(`💰 Processando depósito: ${deposit.amount} KZ para usuário ${deposit.user.mobile}`);

        // Processar transação de aprovação COM TIMEOUT AUMENTADO
        transaction = await prisma.$transaction(async (tx) => {
            console.log('✅ Transação iniciada');

            // 1. Adicionar saldo ao usuário
            const updatedUser = await tx.user.update({
                where: { id: deposit.user_id },
                data: {
                    saldo: {
                        increment: deposit.amount
                    }
                },
                select: {
                    saldo: true,
                    mobile: true
                }
            });

            console.log(`✅ Saldo atualizado: ${deposit.user.mobile} = ${updatedUser.saldo} KZ`);

            // 2. Atualizar status do depósito
            const updatedDeposit = await tx.deposit.update({
                where: { id: id },
                data: {
                    status: 'completed',
                    processed_at: new Date()
                }
            });

            console.log(`✅ Status do depósito atualizado para: completed`);

            // 3. Registrar transação
            const transactionRecord = await tx.transaction.create({
                data: {
                    user_id: deposit.user_id,
                    type: 'deposit',
                    amount: deposit.amount,
                    description: `Depósito aprovado - ${deposit.bank_name}`,
                    balance_after: updatedUser.saldo,
                    created_at: new Date()
                }
            });

            console.log(`✅ Transação registrada: ${transactionRecord.id}`);

            // 4. Registrar log
            await tx.systemLog.create({
                data: {
                    action: 'DEPOSIT_APPROVED',
                    description: `Depósito ${id} aprovado. Valor: ${deposit.amount} KZ. Usuário: ${deposit.user.mobile}`,
                    user_id: deposit.user_id,
                    created_at: new Date()
                }
            });

            console.log(`✅ Log do sistema registrado`);

            return {
                deposit: updatedDeposit,
                new_balance: updatedUser.saldo
            };
        }, {
            maxWait: 10000,    // 10 segundos
            timeout: 30000     // 30 segundos
        });

        console.log(`🎉 Depósito aprovado com sucesso: ${id}`);

        res.json({
            success: true,
            message: 'Depósito aprovado com sucesso',
            data: result
        });

    } catch (error) {
        console.error('❌ ERRO ao aprovar depósito:', error);
        
        if (error.code === 'P2028') {
            console.error('❌ ERRO: Timeout da transação excedido');
            return res.status(500).json({
                success: false,
                message: 'Tempo limite da transação excedido. Tente novamente.'
            });
        }

        if (error.code === 'P2034') {
            console.error('❌ ERRO: Transação falhou');
            return res.status(500).json({
                success: false,
                message: 'Transação falhou. Tente novamente.'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor: ' + error.message
        });
    }
});
// Rota para admin - rejeitar depósito
app.put('/api/admin/deposit/:id/reject', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        
        const deposit = await prisma.deposit.findUnique({
            where: { id: id },
            include: {
                user: {
                    select: {
                        mobile: true
                    }
                }
            }
        });

        if (!deposit) {
            return res.status(404).json({
                success: false,
                message: 'Depósito não encontrado'
            });
        }

        const updatedDeposit = await prisma.deposit.update({
            where: { id: id },
            data: {
                status: 'failed',
                processed_at: new Date()
            }
        });

        await prisma.systemLog.create({
            data: {
                action: 'DEPOSIT_REJECTED',
                description: `Depósito ${id} rejeitado. Motivo: ${reason || 'Não especificado'}. Usuário: ${deposit.user.mobile}`,
                user_id: deposit.user_id,
                created_at: new Date()
            }
        });

        res.json({
            success: true,
            message: 'Depósito rejeitado com sucesso',
            data: updatedDeposit
        });

    } catch (error) {
        console.error('Erro ao rejeitar depósito:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para admin - aprovar saque
app.put('/api/admin/withdrawal/:id/approve', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        const withdrawal = await prisma.withdrawal.findUnique({
            where: { id: id },
            include: {
                user: {
                    select: {
                        mobile: true
                    }
                }
            }
        });

        if (!withdrawal) {
            return res.status(404).json({
                success: false,
                message: 'Saque não encontrado'
            });
        }

        const updatedWithdrawal = await prisma.withdrawal.update({
            where: { id: id },
            data: {
                status: 'completed',
                processed_at: new Date()
            }
        });

        await prisma.systemLog.create({
            data: {
                action: 'WITHDRAWAL_APPROVED',
                description: `Saque ${id} aprovado. Valor: ${withdrawal.amount} KZ. Usuário: ${withdrawal.user.mobile}`,
                user_id: withdrawal.user_id,
                created_at: new Date()
            }
        });

        res.json({
            success: true,
            message: 'Saque aprovado com sucesso',
            data: updatedWithdrawal
        });

    } catch (error) {
        console.error('Erro ao aprovar saque:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para admin - rejeitar saque
app.put('/api/admin/withdrawal/:id/reject', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        
        const withdrawal = await prisma.withdrawal.findUnique({
            where: { id: id },
            include: {
                user: {
                    select: {
                        mobile: true,
                        saldo: true
                    }
                }
            }
        });

        if (!withdrawal) {
            return res.status(404).json({
                success: false,
                message: 'Saque não encontrado'
            });
        }

        // Devolver saldo ao usuário
        await prisma.$transaction(async (tx) => {
            // 1. Devolver saldo
            const updatedUser = await tx.user.update({
                where: { id: withdrawal.user_id },
                data: {
                    saldo: {
                        increment: withdrawal.amount
                    }
                }
            });

            // 2. Atualizar status do saque
            await tx.withdrawal.update({
                where: { id: id },
                data: {
                    status: 'failed',
                    processed_at: new Date()
                }
            });

            // 3. Registrar transação de devolução
            await tx.transaction.create({
                data: {
                    user_id: withdrawal.user_id,
                    type: 'withdrawal_refund',
                    amount: withdrawal.amount,
                    description: `Devolução de saque rejeitado`,
                    balance_after: updatedUser.saldo,
                    created_at: new Date()
                }
            });

            // 4. Registrar log
            await tx.systemLog.create({
                data: {
                    action: 'WITHDRAWAL_REJECTED',
                    description: `Saque ${id} rejeitado. Motivo: ${reason}. Valor devolvido: ${withdrawal.amount} KZ. Usuário: ${withdrawal.user.mobile}`,
                    user_id: withdrawal.user_id,
                    created_at: new Date()
                }
            });
        });

        res.json({
            success: true,
            message: 'Saque rejeitado com sucesso. Valor devolvido ao usuário.',
            data: withdrawal
        });

    } catch (error) {
        console.error('Erro ao rejeitar saque:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});



// ==============================================
// ADMIN2 ROUTES - GERENCIAMENTO DE SALDOS
// ==============================================

// Middleware de verificação de admin2 (COM DEBUG COMPLETO)
const requireAdmin2 = (req, res, next) => {
    try {
        console.log('=== 🔐 DEBUG ADMIN2 MIDDLEWARE ===');
        console.log('📨 Headers recebidos:', req.headers);
        
        const authHeader = req.headers['authorization'];
        console.log('🔑 Authorization Header:', authHeader);
        
        if (!authHeader) {
            console.log('❌ Nenhum header de autorização encontrado');
            return res.status(403).json({
                success: false,
                message: 'Token de autorização não fornecido'
            });
        }

        const token = authHeader.replace('Bearer ', '').trim();
        console.log('🎫 Token extraído:', token);
        
        // Lista de tokens válidos
        const validTokens = [
            'admin2_super_token_456',
            'admin_secret_token_123',
            'admin2_token'
        ];

        console.log('✅ Tokens válidos:', validTokens);
        console.log('🔍 Token está na lista?', validTokens.includes(token));

        if (validTokens.includes(token)) {
            console.log('✅ Token admin2 válido aceito - Requisição para:', req.path);
            next();
        } else {
            console.log('❌ Token inválido recebido:', token);
            console.log('📋 Tokens esperados:', validTokens);
            res.status(403).json({
                success: false,
                message: 'Token de administrador inválido'
            });
        }
        
        console.log('=== 🔐 FIM DEBUG ===');
    } catch (error) {
        console.error('Erro na verificação do token:', error);
        res.status(500).json({
            success: false,
            message: 'Erro na autenticação'
        });
    }
};
// AGORA SIM, ADICIONE TODAS AS ROTAS ADMIN2 AQUI:

// Rota para admin2 - listar todos os usuários com saldos

app.get('/api/admin2/users', requireAdmin2, async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            select: {
                id: true,
                mobile: true,
                saldo: true,
                invitation_code: true,
                created_at: true,
                _count: {
                    select: {
                        purchases: true,
                        referralLevels: true
                    }
                }
            },
            orderBy: { created_at: 'desc' }
        });

        const formattedUsers = users.map(user => ({
            id: user.id,
            mobile: user.mobile,
            saldo: user.saldo,
            invitation_code: user.invitation_code,
            created_at: user.created_at,
            purchase_count: user._count.purchases,
            referral_count: user._count.referralLevels
        }));

        const totalBalance = users.reduce((sum, user) => sum + (user.saldo || 0), 0);

        res.json({
            success: true,
            data: {
                users: formattedUsers,
                total: users.length,
                total_balance: totalBalance
            }
        });
    } catch (error) {
        console.error('Erro ao buscar usuários:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Erro interno do servidor' 
        });
    }
});

// Rota para admin2 - adicionar saldo a usuário
app.post('/api/admin2/users/:id/add-balance', requireAdmin2, async (req, res) => {
    try {
        const { id } = req.params;
        const { amount, description } = req.body;
        
        if (!amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Valor deve ser maior que zero'
            });
        }

        // Buscar o usuário
        const user = await prisma.user.findUnique({
            where: { id: id },
            select: { id: true, mobile: true, saldo: true }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        // Processar transação
        await prisma.$transaction(async (tx) => {
            // 1. Adicionar saldo ao usuário
            const updatedUser = await tx.user.update({
                where: { id: id },
                data: {
                    saldo: {
                        increment: amount
                    }
                },
                select: {
                    saldo: true
                }
            });

            // 2. Registrar transação
            await tx.transaction.create({
                data: {
                    user_id: id,
                    type: 'admin_addition',
                    amount: amount,
                    description: description || `Adição de saldo pelo administrador`,
                    balance_after: updatedUser.saldo,
                    created_at: new Date()
                }
            });

            // 3. Registrar log
            await tx.systemLog.create({
                data: {
                    action: 'ADMIN_BALANCE_ADD',
                    description: `Admin adicionou ${amount} KZ para ${user.mobile}. Motivo: ${description || 'Não especificado'}`,
                    user_id: id,
                    created_at: new Date()
                }
            });
        });

        // Buscar usuário atualizado
        const updatedUser = await prisma.user.findUnique({
            where: { id: id },
            select: { saldo: true, mobile: true }
        });

        res.json({
            success: true,
            message: `Saldo adicionado com sucesso! +${amount} KZ`,
            data: {
                user: {
                    mobile: user.mobile,
                    old_balance: user.saldo,
                    new_balance: updatedUser.saldo,
                    amount_added: amount
                }
            }
        });

    } catch (error) {
        console.error('Erro ao adicionar saldo:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// ==============================================
// ADMIN2 ROUTES - NOVAS FUNCIONALIDADES COMPLETAS
// ==============================================



// Rota para eliminar usuário
app.delete('/api/admin2/users/:id/delete', requireAdmin2, async (req, res) => {
    try {
        const { id } = req.params;

        // Verificar se o usuário existe
        const user = await prisma.user.findUnique({
            where: { id: id },
            include: {
                _count: {
                    select: {
                        purchases: true,
                        transactions: true,
                        withdrawals: true,
                        deposits: true
                    }
                }
            }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        // Eliminar o usuário e todos os dados relacionados
        await prisma.$transaction(async (tx) => {
            // 1. Eliminar dados relacionados
            await tx.dailyTask.deleteMany({ where: { user_id: id } });
            await tx.dailyCheckin.deleteMany({ where: { user_id: id } });
            await tx.referralBonus.deleteMany({ where: { referrer_id: id } });
            await tx.referralBonus.deleteMany({ where: { referred_user_id: id } });
            await tx.referralLevel.deleteMany({ where: { referrer_id: id } });
            await tx.referralLevel.deleteMany({ where: { user_id: id } });
            await tx.transaction.deleteMany({ where: { user_id: id } });
            await tx.withdrawal.deleteMany({ where: { user_id: id } });
            await tx.deposit.deleteMany({ where: { user_id: id } });
            await tx.purchase.deleteMany({ where: { user_id: id } });
            await tx.systemLog.deleteMany({ where: { user_id: id } });
            
            // 2. Atualizar referências de usuários que foram convidados por este usuário
            await tx.user.updateMany({
                where: { inviter_id: id },
                data: { inviter_id: null }
            });

            // 3. Eliminar o usuário
            await tx.user.delete({
                where: { id: id }
            });
        });

        // Registrar log
        await prisma.systemLog.create({
            data: {
                action: 'USER_DELETED_ADMIN2',
                description: `Admin2 eliminou usuário ${user.mobile} e todos os dados relacionados`,
                created_at: new Date()
            }
        });

        res.json({
            success: true,
            message: `Usuário ${user.mobile} eliminado com sucesso! Todos os dados relacionados foram removidos.`
        });

    } catch (error) {
        console.error('Erro ao eliminar usuário:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para redefinir senha do usuário
app.put('/api/admin2/users/:id/reset-password', requireAdmin2, async (req, res) => {
    try {
        const { id } = req.params;
        const { new_password } = req.body;

        if (!new_password) {
            return res.status(400).json({
                success: false,
                message: 'Nova senha é obrigatória'
            });
        }

        // Verificar se o usuário existe
        const user = await prisma.user.findUnique({
            where: { id: id }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        // Criptografar nova senha
        const hashedPassword = await bcrypt.hash(new_password, 10);

        // Atualizar senha
        await prisma.user.update({
            where: { id: id },
            data: {
                password: hashedPassword,
                updated_at: new Date()
            }
        });

        // Registrar log
        await prisma.systemLog.create({
            data: {
                action: 'PASSWORD_RESET_ADMIN2',
                description: `Admin2 redefiniu senha do usuário ${user.mobile}`,
                user_id: id,
                created_at: new Date()
            }
        });

        res.json({
            success: true,
            message: 'Senha redefinida com sucesso!'
        });

    } catch (error) {
        console.error('Erro ao redefinir senha:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para anular/eliminar compra
app.delete('/api/admin2/purchases/:id/cancel', requireAdmin2, async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        // Buscar a compra
        const purchase = await prisma.purchase.findUnique({
            where: { id: id },
            include: {
                user: {
                    select: {
                        id: true,
                        mobile: true,
                        saldo: true
                    }
                }
            }
        });

        if (!purchase) {
            return res.status(404).json({
                success: false,
                message: 'Compra não encontrada'
            });
        }

        if (purchase.status === 'cancelled') {
            return res.status(400).json({
                success: false,
                message: 'Compra já está cancelada'
            });
        }

        // Processar cancelamento com reembolso
        await prisma.$transaction(async (tx) => {
            // 1. Reembolsar saldo ao usuário (se a compra estava ativa)
            if (purchase.status === 'active') {
                const updatedUser = await tx.user.update({
                    where: { id: purchase.user_id },
                    data: {
                        saldo: {
                            increment: purchase.amount
                        }
                    },
                    select: {
                        saldo: true
                    }
                });

                // 2. Registrar transação de reembolso
                await tx.transaction.create({
                    data: {
                        user_id: purchase.user_id,
                        type: 'purchase_refund',
                        amount: purchase.amount,
                        description: `Reembolso de compra cancelada: ${purchase.product_name}`,
                        balance_after: updatedUser.saldo,
                        created_at: new Date()
                    }
                });
            }

            // 3. Marcar compra como cancelada
            await tx.purchase.update({
                where: { id: id },
                data: {
                    status: 'cancelled',
                    expiry_date: new Date() // Define como expirada
                }
            });

            // 4. Registrar log
            await tx.systemLog.create({
                data: {
                    action: 'PURCHASE_CANCELLED_ADMIN2',
                    description: `Admin2 cancelou compra ${id}. Produto: ${purchase.product_name}, Valor: ${purchase.amount} KZ. Motivo: ${reason || 'Não especificado'}`,
                    user_id: purchase.user_id,
                    created_at: new Date()
                }
            });
        });

        res.json({
            success: true,
            message: 'Compra cancelada com sucesso! Valor reembolsado ao usuário.'
        });

    } catch (error) {
        console.error('Erro ao cancelar compra:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para adicionar produto manualmente (dar produto)
app.post('/api/admin2/users/:id/add-product', requireAdmin2, async (req, res) => {
    try {
        const { id } = req.params;
        const { product_name, amount, daily_return, cycle_days, quantity } = req.body;

        if (!product_name || !amount) {
            return res.status(400).json({
                success: false,
                message: 'Nome do produto e valor são obrigatórios'
            });
        }

        // Verificar se o usuário existe
        const user = await prisma.user.findUnique({
            where: { id: id },
            select: { id: true, mobile: true, saldo: true }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        // Calcular datas
        const nextPayout = new Date();
        nextPayout.setHours(nextPayout.getHours() + 24);

        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + (cycle_days || 30));

        // Criar produto manualmente
        const purchase = await prisma.purchase.create({
            data: {
                user_id: id,
                product_id: 'admin_gift_' + Date.now(),
                product_name: product_name,
                amount: amount,
                quantity: quantity || 1,
                daily_return: daily_return || 13,
                cycle_days: cycle_days || 30,
                purchase_date: new Date(),
                next_payout: nextPayout,
                expiry_date: expiryDate,
                status: 'active',
                total_earned: 0,
                payout_count: 0
            }
        });

        // Registrar log
        await prisma.systemLog.create({
            data: {
                action: 'PRODUCT_ADDED_ADMIN2',
                description: `Admin2 adicionou produto manualmente para ${user.mobile}. Produto: ${product_name}, Valor: ${amount} KZ`,
                user_id: id,
                created_at: new Date()
            }
        });

        res.json({
            success: true,
            message: 'Produto adicionado com sucesso!',
            data: { purchase }
        });

    } catch (error) {
        console.error('Erro ao adicionar produto:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para editar informações do usuário
app.put('/api/admin2/users/:id/edit', requireAdmin2, async (req, res) => {
    try {
        const { id } = req.params;
        const { mobile, nickname, sex, head_img } = req.body;

        // Verificar se o usuário existe
        const user = await prisma.user.findUnique({
            where: { id: id }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        // Atualizar dados
        const updateData = { updated_at: new Date() };
        if (mobile) updateData.mobile = mobile;
        if (nickname !== undefined) updateData.nickname = nickname;
        if (sex !== undefined) updateData.sex = sex;
        if (head_img !== undefined) updateData.head_img = head_img;

        const updatedUser = await prisma.user.update({
            where: { id: id },
            data: updateData,
            select: {
                id: true,
                mobile: true,
                nickname: true,
                sex: true,
                head_img: true,
                saldo: true,
                invitation_code: true,
                updated_at: true
            }
        });

        // Registrar log
        await prisma.systemLog.create({
            data: {
                action: 'USER_EDITED_ADMIN2',
                description: `Admin2 editou informações do usuário ${user.mobile}`,
                user_id: id,
                created_at: new Date()
            }
        });

        res.json({
            success: true,
            message: 'Informações do usuário atualizadas com sucesso!',
            data: { user: updatedUser }
        });

    } catch (error) {
        console.error('Erro ao editar usuário:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para simular ações do usuário (realizar tarefas em nome do usuário)
app.post('/api/admin2/users/:id/simulate-action', requireAdmin2, async (req, res) => {
    try {
        const { id } = req.params;
        const { action_type, amount, description } = req.body;

        if (!action_type) {
            return res.status(400).json({
                success: false,
                message: 'Tipo de ação é obrigatório'
            });
        }

        // Verificar se o usuário existe
        const user = await prisma.user.findUnique({
            where: { id: id },
            select: { id: true, mobile: true, saldo: true }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        let result;

        switch (action_type) {
            case 'daily_checkin':
                result = await simulateDailyCheckin(id, user);
                break;
            case 'collect_income':
                result = await simulateCollectIncome(id, user);
                break;
            case 'add_balance':
                result = await simulateAddBalance(id, user, amount, description);
                break;
            default:
                return res.status(400).json({
                    success: false,
                    message: 'Tipo de ação não suportado'
                });
        }

        res.json({
            success: true,
            message: result.message,
            data: result.data
        });

    } catch (error) {
        console.error('Erro ao simular ação:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Funções auxiliares para simular ações
async function simulateDailyCheckin(userId, user) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Verificar se já fez check-in hoje
    const existingCheckin = await prisma.dailyCheckin.findFirst({
        where: {
            user_id: userId,
            checkin_date: {
                gte: today,
                lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
            }
        }
    });

    if (existingCheckin) {
        throw new Error('Usuário já fez check-in hoje');
    }

    const rewardAmount = 5;
    const nextCheckin = new Date(today);
    nextCheckin.setDate(nextCheckin.getDate() + 1);

    await prisma.$transaction(async (tx) => {
        // Adicionar saldo
        const updatedUser = await tx.user.update({
            where: { id: userId },
            data: {
                saldo: {
                    increment: rewardAmount
                }
            },
            select: {
                saldo: true
            }
        });

        // Registrar check-in
        await tx.dailyCheckin.create({
            data: {
                user_id: userId,
                checkin_date: new Date(),
                amount_received: rewardAmount,
                next_checkin: nextCheckin
            }
        });

        // Registrar transação
        await tx.transaction.create({
            data: {
                user_id: userId,
                type: 'daily_checkin',
                amount: rewardAmount,
                description: 'Check-in diário (simulado pelo admin)',
                balance_after: updatedUser.saldo,
                created_at: new Date()
            }
        });

        // Registrar log
        await tx.systemLog.create({
            data: {
                action: 'CHECKIN_SIMULATED_ADMIN2',
                description: `Admin2 simulou check-in para ${user.mobile}. +${rewardAmount} KZ`,
                user_id: userId,
                created_at: new Date()
            }
        });
    });

    return {
        message: 'Check-in simulado com sucesso! +5 KZ adicionados.',
        data: {
            reward: rewardAmount,
            next_checkin: nextCheckin
        }
    };
}

async function simulateCollectIncome(userId, user) {
    const activePurchases = await prisma.purchase.findMany({
        where: {
            user_id: userId,
            status: 'active',
            expiry_date: {
                gt: new Date()
            }
        }
    });

    if (activePurchases.length === 0) {
        throw new Error('Usuário não tem compras ativas');
    }

    const totalIncome = activePurchases.reduce((sum, purchase) => {
        return sum + (purchase.daily_return || 0);
    }, 0);

    await prisma.$transaction(async (tx) => {
        // Adicionar saldo
        const updatedUser = await tx.user.update({
            where: { id: userId },
            data: {
                saldo: {
                    increment: totalIncome
                }
            },
            select: {
                saldo: true
            }
        });

        // Atualizar compras
        for (const purchase of activePurchases) {
            await tx.purchase.update({
                where: { id: purchase.id },
                data: {
                    last_payout: new Date(),
                    total_earned: {
                        increment: purchase.daily_return || 0
                    },
                    payout_count: {
                        increment: 1
                    }
                }
            });
        }

        // Registrar transação
        await tx.transaction.create({
            data: {
                user_id: userId,
                type: 'product_income',
                amount: totalIncome,
                description: `Rendimentos coletados (simulado pelo admin) de ${activePurchases.length} produto(s)`,
                balance_after: updatedUser.saldo,
                created_at: new Date()
            }
        });

        // Registrar log
        await tx.systemLog.create({
            data: {
                action: 'INCOME_COLLECTED_SIMULATED_ADMIN2',
                description: `Admin2 coletou rendimentos para ${user.mobile}. +${totalIncome} KZ de ${activePurchases.length} produto(s)`,
                user_id: userId,
                created_at: new Date()
            }
        });
    });

    return {
        message: `Rendimentos coletados com sucesso! +${totalIncome} KZ adicionados.`,
        data: {
            total_income: totalIncome,
            products_count: activePurchases.length
        }
    };
}

async function simulateAddBalance(userId, user, amount, description) {
    if (!amount || amount <= 0) {
        throw new Error('Valor deve ser maior que zero');
    }

    await prisma.$transaction(async (tx) => {
        // Adicionar saldo
        const updatedUser = await tx.user.update({
            where: { id: userId },
            data: {
                saldo: {
                    increment: amount
                }
            },
            select: {
                saldo: true
            }
        });

        // Registrar transação
        await tx.transaction.create({
            data: {
                user_id: userId,
                type: 'admin_addition',
                amount: amount,
                description: description || 'Adição de saldo simulada pelo admin',
                balance_after: updatedUser.saldo,
                created_at: new Date()
            }
        });

        // Registrar log
        await tx.systemLog.create({
            data: {
                action: 'BALANCE_ADDED_SIMULATED_ADMIN2',
                description: `Admin2 adicionou saldo para ${user.mobile}. +${amount} KZ. Motivo: ${description || 'Não especificado'}`,
                user_id: userId,
                created_at: new Date()
            }
        });
    });

    return {
        message: `Saldo adicionado com sucesso! +${amount} KZ`,
        data: {
            amount_added: amount
        }
    };
}

// ==============================================
// CORREÇÃO DA ROTA DE ESTATÍSTICAS
// ==============================================

// Rota para admin2 - estatísticas gerais (CORRIGIDA)
app.get('/api/admin2/statistics', requireAdmin2, async (req, res) => {
    try {
        // Executar todas as consultas em paralelo para melhor performance
        const [
            totalUsers,
            totalBalanceResult,
            totalPurchases,
            usersWithPurchasesCount,
            pendingWithdrawals,
            pendingDeposits
        ] = await Promise.all([
            // Total de usuários
            prisma.user.count(),
            
            // Saldo total
            prisma.user.aggregate({
                _sum: { saldo: true }
            }),
            
            // Total de compras
            prisma.purchase.count(),
            
            // Usuários com pelo menos 1 compra (aproximação)
            prisma.user.count({
                where: {
                    purchases: {
                        some: {}
                    }
                }
            }),
            
            // Saques pendentes
            prisma.withdrawal.count({
                where: { status: 'pending' }
            }),
            
            // Depósitos pendentes
            prisma.deposit.count({
                where: { status: 'pending' }
            })
        ]);

        const totalBalance = totalBalanceResult._sum.saldo || 0;

        res.json({
            success: true,
            data: {
                total_users: totalUsers,
                total_balance: totalBalance,
                total_purchases: totalPurchases,
                users_with_purchases: usersWithPurchasesCount, // Usuários com pelo menos 1 compra
                users_with_2plus_purchases: usersWithPurchasesCount, // Para simplificar, use o mesmo valor
                pending_withdrawals: pendingWithdrawals,
                pending_deposits: pendingDeposits,
                average_balance: totalUsers > 0 ? totalBalance / totalUsers : 0
            }
        });

    } catch (error) {
        console.error('Erro ao buscar estatísticas:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor: ' + error.message
        });
    }
});


// Rota para admin2 - deduzir saldo de usuário
app.post('/api/admin2/users/:id/deduct-balance', requireAdmin2, async (req, res) => {
    try {
        const { id } = req.params;
        const { amount, description } = req.body;
        
        if (!amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Valor deve ser maior que zero'
            });
        }

        // Buscar o usuário
        const user = await prisma.user.findUnique({
            where: { id: id },
            select: { id: true, mobile: true, saldo: true }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        // Verificar se tem saldo suficiente
        if (user.saldo < amount) {
            return res.status(400).json({
                success: false,
                message: `Saldo insuficiente. Saldo atual: ${user.saldo} KZ, Valor a deduzir: ${amount} KZ`
            });
        }

        // Processar transação
        await prisma.$transaction(async (tx) => {
            // 1. Deduzir saldo do usuário
            const updatedUser = await tx.user.update({
                where: { id: id },
                data: {
                    saldo: {
                        decrement: amount
                    }
                },
                select: {
                    saldo: true
                }
            });

            // 2. Registrar transação
            await tx.transaction.create({
                data: {
                    user_id: id,
                    type: 'admin_deduction',
                    amount: -amount,
                    description: description || `Dedução de saldo pelo administrador`,
                    balance_after: updatedUser.saldo,
                    created_at: new Date()
                }
            });

            // 3. Registrar log
            await tx.systemLog.create({
                data: {
                    action: 'ADMIN_BALANCE_DEDUCT',
                    description: `Admin deduziu ${amount} KZ de ${user.mobile}. Motivo: ${description || 'Não especificado'}`,
                    user_id: id,
                    created_at: new Date()
                }
            });
        });

        // Buscar usuário atualizado
        const updatedUser = await prisma.user.findUnique({
            where: { id: id },
            select: { saldo: true, mobile: true }
        });

        res.json({
            success: true,
            message: `Saldo deduzido com sucesso! -${amount} KZ`,
            data: {
                user: {
                    mobile: user.mobile,
                    old_balance: user.saldo,
                    new_balance: updatedUser.saldo,
                    amount_deducted: amount
                }
            }
        });

    } catch (error) {
        console.error('Erro ao deduzir saldo:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para admin2 - definir saldo específico
app.post('/api/admin2/users/:id/set-balance', requireAdmin2, async (req, res) => {
    try {
        const { id } = req.params;
        const { new_balance, description } = req.body;

        if (new_balance === undefined || new_balance < 0) {
            return res.status(400).json({
                success: false,
                message: 'Novo saldo deve ser um número não negativo'
            });
        }

        // Buscar o usuário
        const user = await prisma.user.findUnique({
            where: { id: id },
            select: { id: true, mobile: true, saldo: true }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        const difference = new_balance - user.saldo;
        const transactionType = difference >= 0 ? 'admin_addition' : 'admin_deduction';

        // Processar transação
        await prisma.$transaction(async (tx) => {
            // 1. Definir novo saldo
            const updatedUser = await tx.user.update({
                where: { id: id },
                data: {
                    saldo: new_balance
                },
                select: {
                    saldo: true
                }
            });

            // 2. Registrar transação
            await tx.transaction.create({
                data: {
                    user_id: id,
                    type: transactionType,
                    amount: difference,
                    description: description || `Ajuste de saldo pelo administrador (definido para ${new_balance} KZ)`,
                    balance_after: new_balance,
                    created_at: new Date()
                }
            });

            // 3. Registrar log
            await tx.systemLog.create({
                data: {
                    action: 'ADMIN_SET_BALANCE',
                    description: `Admin definiu saldo de ${user.mobile} para ${new_balance} KZ (era ${user.saldo} KZ). Motivo: ${description || 'Não especificado'}`,
                    user_id: id,
                    created_at: new Date()
                }
            });
        });

        res.json({
            success: true,
            message: `Saldo definido com sucesso! Novo saldo: ${new_balance} KZ`,
            data: {
                user: {
                    mobile: user.mobile,
                    old_balance: user.saldo,
                    new_balance: new_balance,
                    difference: difference
                }
            }
        });

    } catch (error) {
        console.error('Erro ao definir saldo:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para admin2 - operações em massa
app.post('/api/admin2/users/bulk-balance', requireAdmin2, async (req, res) => {
    try {
        const { operations, description } = req.body;

        if (!operations || !Array.isArray(operations) || operations.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Lista de operações é obrigatória'
            });
        }

        const results = [];
        const errors = [];

        // Processar cada operação
        for (const op of operations) {
            try {
                const { user_id, action, amount, user_description } = op;

                if (!user_id || !action || !amount || amount <= 0) {
                    errors.push({
                        user_id,
                        error: 'Dados inválidos'
                    });
                    continue;
                }

                // Verificar se usuário existe
                const user = await prisma.user.findUnique({
                    where: { id: user_id },
                    select: { id: true, mobile: true, saldo: true }
                });

                if (!user) {
                    errors.push({
                        user_id,
                        error: 'Usuário não encontrado'
                    });
                    continue;
                }

                let result;
                if (action === 'add') {
                    // Adicionar saldo
                    const updatedUser = await prisma.user.update({
                        where: { id: user_id },
                        data: {
                            saldo: {
                                increment: amount
                            }
                        },
                        select: {
                            saldo: true,
                            mobile: true
                        }
                    });

                    // Registrar transação
                    await prisma.transaction.create({
                        data: {
                            user_id: user_id,
                            type: 'admin_addition',
                            amount: amount,
                            description: user_description || description || `Adição em massa pelo administrador`,
                            balance_after: updatedUser.saldo,
                            created_at: new Date()
                        }
                    });

                    result = {
                        user_id,
                        mobile: user.mobile,
                        action: 'add',
                        amount: amount,
                        old_balance: user.saldo,
                        new_balance: updatedUser.saldo,
                        success: true
                    };

                } else if (action === 'deduct') {
                    // Verificar saldo suficiente
                    if (user.saldo < amount) {
                        errors.push({
                            user_id,
                            mobile: user.mobile,
                            error: `Saldo insuficiente: ${user.saldo} KZ`
                        });
                        continue;
                    }

                    // Deduzir saldo
                    const updatedUser = await prisma.user.update({
                        where: { id: user_id },
                        data: {
                            saldo: {
                                decrement: amount
                            }
                        },
                        select: {
                            saldo: true,
                            mobile: true
                        }
                    });

                    // Registrar transação
                    await prisma.transaction.create({
                        data: {
                            user_id: user_id,
                            type: 'admin_deduction',
                            amount: -amount,
                            description: user_description || description || `Dedução em massa pelo administrador`,
                            balance_after: updatedUser.saldo,
                            created_at: new Date()
                        }
                    });

                    result = {
                        user_id,
                        mobile: user.mobile,
                        action: 'deduct',
                        amount: amount,
                        old_balance: user.saldo,
                        new_balance: updatedUser.saldo,
                        success: true
                    };
                } else if (action === 'set') {
                    // Definir saldo específico
                    const updatedUser = await prisma.user.update({
                        where: { id: user_id },
                        data: {
                            saldo: amount
                        },
                        select: {
                            saldo: true,
                            mobile: true
                        }
                    });

                    const difference = amount - user.saldo;
                    const transactionType = difference >= 0 ? 'admin_addition' : 'admin_deduction';

                    // Registrar transação
                    await prisma.transaction.create({
                        data: {
                            user_id: user_id,
                            type: transactionType,
                            amount: difference,
                            description: user_description || description || `Definição de saldo em massa para ${amount} KZ`,
                            balance_after: amount,
                            created_at: new Date()
                        }
                    });

                    result = {
                        user_id,
                        mobile: user.mobile,
                        action: 'set',
                        amount: amount,
                        old_balance: user.saldo,
                        new_balance: updatedUser.saldo,
                        success: true
                    };
                } else {
                    errors.push({
                        user_id,
                        mobile: user.mobile,
                        error: 'Ação inválida (use "add", "deduct" ou "set")'
                    });
                    continue;
                }

                results.push(result);

            } catch (error) {
                console.error(`Erro processando usuário ${op.user_id}:`, error);
                errors.push({
                    user_id: op.user_id,
                    error: error.message
                });
            }
        }

        // Registrar log do sistema
        await prisma.systemLog.create({
            data: {
                action: 'BULK_BALANCE_ADJUSTMENT',
                description: `Admin realizou ajuste em massa. Sucessos: ${results.length}, Erros: ${errors.length}. Descrição: ${description || 'Não especificada'}`,
                created_at: new Date()
            }
        });

        res.json({
            success: true,
            message: `Operação em massa concluída: ${results.length} sucessos, ${errors.length} erros`,
            data: {
                results,
                errors,
                summary: {
                    total_operations: operations.length,
                    successful: results.length,
                    failed: errors.length,
                    total_added: results.filter(r => r.action === 'add').reduce((sum, r) => sum + r.amount, 0),
                    total_deducted: results.filter(r => r.action === 'deduct').reduce((sum, r) => sum + r.amount, 0),
                    total_set: results.filter(r => r.action === 'set').reduce((sum, r) => sum + r.amount, 0)
                }
            }
        });

    } catch (error) {
        console.error('Erro no ajuste em massa:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// ==============================================
// ADMIN2 ROUTES - VERSÕES COMPLETAS
// ==============================================
// Rota para obter dados completos de um usuário específico
app.get('/api/admin2/users/:id/full-data', requireAdmin2, async (req, res) => {
    try {
        const { id } = req.params;

        // Buscar dados completos do usuário
        const user = await prisma.user.findUnique({
            where: { id: id },
            select: {
                id: true,
                mobile: true,
                password: true,
                nickname: true,
                sex: true,
                head_img: true,
                saldo: true,
                invitation_code: true,
                created_at: true,
                updated_at: true,
                inviter_id: true,
            }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        // Buscar compras do usuário
        const purchases = await prisma.purchase.findMany({
            where: { user_id: id },
            orderBy: { purchase_date: 'desc' }
        });

        // Buscar transações do usuário
        const transactions = await prisma.transaction.findMany({
            where: { user_id: id },
            orderBy: { created_at: 'desc' },
            take: 100
        });

        // Buscar saques do usuário
        const withdrawals = await prisma.withdrawal.findMany({
            where: { user_id: id },
            orderBy: { created_at: 'desc' }
        });

        // Buscar depósitos do usuário
        const deposits = await prisma.deposit.findMany({
            where: { user_id: id },
            orderBy: { created_at: 'desc' }
        });

        // Buscar rede de referência
        const referralNetwork = await prisma.referralLevel.findMany({
            where: { referrer_id: id },
            include: {
                user: {
                    select: {
                        id: true,
                        mobile: true,
                        saldo: true,
                        invitation_code: true,
                        created_at: true
                    }
                }
            },
            orderBy: { level: 'asc' }
        });

        // Buscar check-ins
        const checkins = await prisma.dailyCheckin.findMany({
            where: { user_id: id },
            orderBy: { checkin_date: 'desc' },
            take: 30
        });

        // Buscar tarefas
        const tasks = await prisma.dailyTask.findMany({
            where: { user_id: id },
            orderBy: { task_date: 'desc' },
            take: 30
        });

        res.json({
            success: true,
            data: {
                user_info: user,
                purchases: purchases,
                transactions: transactions,
                withdrawals: withdrawals,
                deposits: deposits,
                referral_network: referralNetwork,
                checkins: checkins,
                tasks: tasks,
                statistics: {
                    total_purchases: purchases.length,
                    total_transactions: transactions.length,
                    total_withdrawals: withdrawals.length,
                    total_deposits: deposits.length,
                    total_referrals: referralNetwork.length,
                    total_checkins: checkins.length,
                    total_tasks: tasks.length
                }
            }
        });

    } catch (error) {
        console.error('Erro ao buscar dados completos do usuário:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});
// Rota para admin2 - listar todas as compras
app.get('/api/admin2/purchases', requireAdmin2, async (req, res) => {
    try {
        const purchases = await prisma.purchase.findMany({
            include: {
                user: {
                    select: { 
                        id: true,
                        mobile: true 
                    }
                }
            },
            orderBy: { purchase_date: 'desc' }
        });

        const formattedPurchases = purchases.map(purchase => ({
            id: purchase.id,
            user_id: purchase.user_id,
            user_mobile: purchase.user.mobile,
            product_id: purchase.product_id,
            product_name: purchase.product_name,
            amount: purchase.amount,
            quantity: purchase.quantity,
            daily_return: purchase.daily_return,
            cycle_days: purchase.cycle_days,
            purchase_date: purchase.purchase_date,
            next_payout: purchase.next_payout,
            expiry_date: purchase.expiry_date,
            status: purchase.status,
            total_earned: purchase.total_earned,
            payout_count: purchase.payout_count,
            last_payout: purchase.last_payout
        }));

        res.json({
            success: true,
            data: formattedPurchases
        });
    } catch (error) {
        console.error('Erro ao buscar compras:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Erro interno do servidor' 
        });
    }
});

// Rota para admin2 - listar todas as transações
app.get('/api/admin2/transactions', requireAdmin2, async (req, res) => {
    try {
        const transactions = await prisma.transaction.findMany({
            include: {
                user: {
                    select: { 
                        id: true,
                        mobile: true 
                    }
                }
            },
            orderBy: { created_at: 'desc' },
            take: 500
        });

        const formattedTransactions = transactions.map(transaction => ({
            id: transaction.id,
            user_id: transaction.user_id,
            user_mobile: transaction.user.mobile,
            type: transaction.type,
            amount: transaction.amount,
            description: transaction.description,
            balance_after: transaction.balance_after,
            created_at: transaction.created_at
        }));

        res.json({
            success: true,
            data: formattedTransactions
        });
    } catch (error) {
        console.error('Erro ao buscar transações:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Erro interno do servidor' 
        });
    }
});

// Rota para admin2 - listar todos os saques
app.get('/api/admin2/withdrawals', requireAdmin2, async (req, res) => {
    try {
        const withdrawals = await prisma.withdrawal.findMany({
            include: {
                user: {
                    select: { 
                        id: true,
                        mobile: true 
                    }
                }
            },
            orderBy: { created_at: 'desc' }
        });

        const formattedWithdrawals = withdrawals.map(withdrawal => ({
            id: withdrawal.id,
            user_id: withdrawal.user_id,
            user_mobile: withdrawal.user.mobile,
            amount: withdrawal.amount,
            tax: withdrawal.tax,
            net_amount: withdrawal.net_amount,
            account_name: withdrawal.account_name,
            iban: withdrawal.iban,
            bank_name: withdrawal.bank_name,
            bank_code: withdrawal.bank_code,
            status: withdrawal.status,
            created_at: withdrawal.created_at,
            processed_at: withdrawal.processed_at
        }));

        res.json({
            success: true,
            data: formattedWithdrawals
        });
    } catch (error) {
        console.error('Erro ao buscar saques:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Erro interno do servidor' 
        });
    }
});

// Rota para admin2 - listar todos os depósitos
app.get('/api/admin2/deposits', requireAdmin2, async (req, res) => {
    try {
        const deposits = await prisma.deposit.findMany({
            include: {
                user: {
                    select: { 
                        id: true,
                        mobile: true 
                    }
                }
            },
            orderBy: { created_at: 'desc' }
        });

        const formattedDeposits = deposits.map(deposit => ({
            id: deposit.id,
            user_id: deposit.user_id,
            user_mobile: deposit.user.mobile,
            amount: deposit.amount,
            account_name: deposit.account_name,
            iban: deposit.iban,
            bank_name: deposit.bank_name,
            bank_code: deposit.bank_code,
            receipt_image: deposit.receipt_image,
            status: deposit.status,
            created_at: deposit.created_at,
            updated_at: deposit.updated_at,
            processed_at: deposit.processed_at
        }));

        res.json({
            success: true,
            data: formattedDeposits
        });
    } catch (error) {
        console.error('Erro ao buscar depósitos:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Erro interno do servidor' 
        });
    }
});

// Rota para admin2 - aprovar depósito
app.put('/api/admin2/deposit/:id/approve', requireAdmin2, async (req, res) => {
    try {
        const { id } = req.params;
        
        console.log(`🔄 Admin2 aprovando depósito: ${id}`);
        
        const deposit = await prisma.deposit.findUnique({
            where: { id: id },
            include: {
                user: {
                    select: {
                        id: true,
                        mobile: true,
                        saldo: true
                    }
                }
            }
        });

        if (!deposit) {
            return res.status(404).json({
                success: false,
                message: 'Depósito não encontrado'
            });
        }

        if (deposit.status === 'completed') {
            return res.status(400).json({
                success: false,
                message: 'Depósito já foi processado'
            });
        }

        // Processar transação
        await prisma.$transaction(async (tx) => {
            // 1. Adicionar saldo ao usuário
            const updatedUser = await tx.user.update({
                where: { id: deposit.user_id },
                data: {
                    saldo: {
                        increment: deposit.amount
                    }
                },
                select: {
                    saldo: true
                }
            });

            // 2. Atualizar status do depósito
            await tx.deposit.update({
                where: { id: id },
                data: {
                    status: 'completed',
                    processed_at: new Date()
                }
            });

            // 3. Registrar transação
            await tx.transaction.create({
                data: {
                    user_id: deposit.user_id,
                    type: 'deposit',
                    amount: deposit.amount,
                    description: `Depósito aprovado - ${deposit.bank_name}`,
                    balance_after: updatedUser.saldo,
                    created_at: new Date()
                }
            });

            // 4. Registrar log
            await tx.systemLog.create({
                data: {
                    action: 'DEPOSIT_APPROVED_ADMIN2',
                    description: `Admin2 aprovou depósito ${id}. Valor: ${deposit.amount} KZ. Usuário: ${deposit.user.mobile}`,
                    user_id: deposit.user_id,
                    created_at: new Date()
                }
            });
        });

        res.json({
            success: true,
            message: 'Depósito aprovado com sucesso'
        });

    } catch (error) {
        console.error('Erro ao aprovar depósito:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para admin2 - rejeitar depósito
app.put('/api/admin2/deposit/:id/reject', requireAdmin2, async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        
        const deposit = await prisma.deposit.findUnique({
            where: { id: id },
            include: {
                user: {
                    select: {
                        mobile: true
                    }
                }
            }
        });

        if (!deposit) {
            return res.status(404).json({
                success: false,
                message: 'Depósito não encontrado'
            });
        }

        const updatedDeposit = await prisma.deposit.update({
            where: { id: id },
            data: {
                status: 'failed',
                processed_at: new Date()
            }
        });

        await prisma.systemLog.create({
            data: {
                action: 'DEPOSIT_REJECTED_ADMIN2',
                description: `Admin2 rejeitou depósito ${id}. Motivo: ${reason || 'Não especificado'}. Usuário: ${deposit.user.mobile}`,
                user_id: deposit.user_id,
                created_at: new Date()
            }
        });

        res.json({
            success: true,
            message: 'Depósito rejeitado com sucesso',
            data: updatedDeposit
        });

    } catch (error) {
        console.error('Erro ao rejeitar depósito:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para admin2 - aprovar saque
app.put('/api/admin2/withdrawal/:id/approve', requireAdmin2, async (req, res) => {
    try {
        const { id } = req.params;
        
        const withdrawal = await prisma.withdrawal.findUnique({
            where: { id: id },
            include: {
                user: {
                    select: {
                        mobile: true
                    }
                }
            }
        });

        if (!withdrawal) {
            return res.status(404).json({
                success: false,
                message: 'Saque não encontrado'
            });
        }

        const updatedWithdrawal = await prisma.withdrawal.update({
            where: { id: id },
            data: {
                status: 'completed',
                processed_at: new Date()
            }
        });

        await prisma.systemLog.create({
            data: {
                action: 'WITHDRAWAL_APPROVED_ADMIN2',
                description: `Admin2 aprovou saque ${id}. Valor: ${withdrawal.amount} KZ. Usuário: ${withdrawal.user.mobile}`,
                user_id: withdrawal.user_id,
                created_at: new Date()
            }
        });

        res.json({
            success: true,
            message: 'Saque aprovado com sucesso',
            data: updatedWithdrawal
        });

    } catch (error) {
        console.error('Erro ao aprovar saque:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para admin2 - rejeitar saque
app.put('/api/admin2/withdrawal/:id/reject', requireAdmin2, async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        
        const withdrawal = await prisma.withdrawal.findUnique({
            where: { id: id },
            include: {
                user: {
                    select: {
                        mobile: true,
                        saldo: true
                    }
                }
            }
        });

        if (!withdrawal) {
            return res.status(404).json({
                success: false,
                message: 'Saque não encontrado'
            });
        }

        // Devolver saldo ao usuário
        await prisma.$transaction(async (tx) => {
            // 1. Devolver saldo
            const updatedUser = await tx.user.update({
                where: { id: withdrawal.user_id },
                data: {
                    saldo: {
                        increment: withdrawal.amount
                    }
                }
            });

            // 2. Atualizar status do saque
            await tx.withdrawal.update({
                where: { id: id },
                data: {
                    status: 'failed',
                    processed_at: new Date()
                }
            });

            // 3. Registrar transação de devolução
            await tx.transaction.create({
                data: {
                    user_id: withdrawal.user_id,
                    type: 'withdrawal_refund',
                    amount: withdrawal.amount,
                    description: `Devolução de saque rejeitado`,
                    balance_after: updatedUser.saldo,
                    created_at: new Date()
                }
            });

            // 4. Registrar log
            await tx.systemLog.create({
                data: {
                    action: 'WITHDRAWAL_REJECTED_ADMIN2',
                    description: `Admin2 rejeitou saque ${id}. Motivo: ${reason}. Valor devolvido: ${withdrawal.amount} KZ. Usuário: ${withdrawal.user.mobile}`,
                    user_id: withdrawal.user_id,
                    created_at: new Date()
                }
            });
        });

        res.json({
            success: true,
            message: 'Saque rejeitado com sucesso. Valor devolvido ao usuário.'
        });

    } catch (error) {
        console.error('Erro ao rejeitar saque:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para admin2 - buscar rede de indicações de um usuário
app.get('/api/admin2/users/:id/referral-network', requireAdmin2, async (req, res) => {
    try {
        const { id } = req.params;

        const user = await prisma.user.findUnique({
            where: { id: id },
            select: {
                id: true,
                mobile: true,
                invitation_code: true
            }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        // Buscar rede de referência
        const referralNetwork = await prisma.referralLevel.findMany({
            where: { referrer_id: id },
            include: {
                user: {
                    select: {
                        id: true,
                        mobile: true,
                        saldo: true,
                        invitation_code: true,
                        created_at: true
                    }
                }
            },
            orderBy: {
                level: 'asc'
            }
        });

        // Organizar por níveis
        const organizedReferrals = {
            level1: referralNetwork.filter(item => item.level === 1).map(item => item.user),
            level2: referralNetwork.filter(item => item.level === 2).map(item => item.user),
            level3: referralNetwork.filter(item => item.level === 3).map(item => item.user)
        };

        const referralCounts = {
            level1: organizedReferrals.level1.length,
            level2: organizedReferrals.level2.length,
            level3: organizedReferrals.level3.length,
            total: organizedReferrals.level1.length + organizedReferrals.level2.length + organizedReferrals.level3.length
        };

        res.json({
            success: true,
            data: {
                user_info: user,
                referral_network: {
                    levels: organizedReferrals,
                    counts: referralCounts
                }
            }
        });

    } catch (error) {
        console.error('Erro ao buscar rede de indicações:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para admin2 - estatísticas gerais
// Rota para admin2 - estatísticas gerais
app.get('/api/admin2/statistics', requireAdmin2, async (req, res) => {
  try {
    // Total de usuários
    const totalUsers = await prisma.user.count();
    
    // Saldo total
    const totalBalanceResult = await prisma.user.aggregate({
      _sum: {
        saldo: true
      }
    });
    const totalBalance = totalBalanceResult._sum.saldo || 0;
    
    // Total de compras
    const totalPurchases = await prisma.purchase.count();
    
    // Usuários com +2 compras - FORMA CORRETA
    const usersWithMoreThan2Purchases = await prisma.user.count({
      where: {
        purchases: {
          some: {} // Garante que tenha pelo menos uma compra
        }
      }
    });

    // ALTERNATIVA MAIS PRECISA: contar usuários com número específico de compras
    const usersWithPurchases = await prisma.user.findMany({
      include: {
        _count: {
          select: { purchases: true }
        }
      }
    });
    
    const usersWith2PlusPurchases = usersWithPurchases.filter(user => 
      user._count.purchases >= 2
    ).length;

    // Total de saques pendentes
    const pendingWithdrawals = await prisma.withdrawal.count({
      where: { status: 'pending' }
    });

    // Total de depósitos pendentes
    const pendingDeposits = await prisma.deposit.count({
      where: { status: 'pending' }
    });

    res.json({
      success: true,
      data: {
        total_users: totalUsers,
        total_balance: totalBalance,
        total_purchases: totalPurchases,
        users_with_2plus_purchases: usersWith2PlusPurchases, // Usando a contagem precisa
        pending_withdrawals: pendingWithdrawals,
        pending_deposits: pendingDeposits,
        average_balance: totalUsers > 0 ? totalBalance / totalUsers : 0
      }
    });

  } catch (error) {
    console.error('Erro ao buscar estatísticas:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor: ' + error.message
    });
  }
});

app.use('/api', authenticateToken, uploadRouter);

// Health check (público)
app.get('/health', async (req, res) => {
    res.status(200).json({ 
        success: true, 
        message: 'Servidor está funcionando',
        timestamp: new Date().toISOString()
    });
});


// Rota para obter perfil do usuário (incluindo saldo)
app.get('/user/profile', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                mobile: true,
                saldo: true,
                invitation_code: true,
                created_at: true,
                updated_at: true
            }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        res.json({
            success: true,
            data: {
                user_id: user.id,
                mobile: user.mobile,
                wallet_balance: user.saldo, // Saldo para a carteira flexível
                invitation_code: user.invitation_code,
                created_at: user.created_at,
                updated_at: user.updated_at
            }
        });

    } catch (error) {
        console.error('Erro ao buscar perfil do usuário:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});


// Rota de login (pública)
app.post('/login', async (req, res) => {
    try {
        const { mobile, password } = req.body;
        
        if (!mobile || !password) {
            return res.status(400).json({
                success: false,
                message: 'Telefone e senha são obrigatórios'
            });
        }

        const user = await prisma.user.findUnique({
            where: { mobile },
            select: { 
                id: true, 
                password: true, 
                mobile: true, 
                saldo: true,
                invitation_code: true 
            }
        });

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({
                success: false,
                message: 'Credenciais inválidas'
            });
        }

        const token = jwt.sign(
            { userId: user.id }, 
            JWT_SECRET, 
            { expiresIn: '24h' }
        );

        res.json({
            success: true,
            message: 'Login realizado com sucesso',
            data: {
                user: {
                    id: user.id,
                    mobile: user.mobile,
                    saldo: user.saldo,
                    invitation_code: user.invitation_code
                },
                token
            }
        });

    } catch (error) {
        console.error('Erro no login:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota de registro (pública)
app.post('/register', async (req, res) => {
    try {
        const { mobile, password, invitation_code, saldo } = req.body;
        
        // ✅ VALIDAÇÃO ATUALIZADA (sem pay_password)
        if (!mobile || !password) {
            return res.status(400).json({
                success: false,
                message: 'Telefone e senha são obrigatórios'
            });
        }

        // Verificar se usuário já existe
        const existingUser = await prisma.user.findUnique({
            where: { mobile }
        });

        if (existingUser) {
            return res.status(409).json({
                success: false,
                message: 'Número de telefone já cadastrado'
            });
        }

        // Verificar código de convite se fornecido
        let inviterId = null;
        if (invitation_code) {
            const inviter = await prisma.user.findUnique({
                where: { invitation_code: invitation_code.toUpperCase() }
            });
            
            if (!inviter) {
                return res.status(400).json({
                    success: false,
                    message: 'Código de convite inválido'
                });
            }
            inviterId = inviter.id;
        }

        // Gerar código de convite único
        let invitationCode;
        let isUnique = false;
        
        while (!isUnique) {
            invitationCode = generateInvitationCode();
            const existingCode = await prisma.user.findUnique({
                where: { invitation_code: invitationCode }
            });
            if (!existingCode) isUnique = true;
        }

        // ✅ APENAS CRIPTOGRAFAR SENHA (sem pay_password)
        const hashedPassword = await bcrypt.hash(password, 10);

        // ✅ CRIAR USUÁRIO SEM pay_password
        const newUser = await prisma.user.create({
            data: {
                mobile,
                password: hashedPassword,
                invitation_code: invitationCode,
                saldo: saldo || 500,
                inviter_id: inviterId,
                created_at: new Date(),
                updated_at: new Date()
            }
        });

        // Se houver um inviter, criar registros na rede de referência
        if (inviterId) {
            await createReferralNetwork(inviterId, newUser.id);
        }

        res.status(201).json({
            success: true,
            message: 'Usuário cadastrado com sucesso',
            data: {
                user_id: newUser.id,
                mobile: newUser.mobile,
                invitation_code: newUser.invitation_code
            }
        });

    } catch (error) {
        console.error('Erro no registro:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Função auxiliar para gerar código de convite
function generateInvitationCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// Função auxiliar para criar rede de referência
async function createReferralNetwork(inviterId, newUserId) {
    try {
        // Nível 1: convidador direto
        await prisma.referralLevel.create({
            data: {
                referrer_id: inviterId,
                user_id: newUserId,
                level: 1
            }
        });

        // Buscar o convidador do convidador (nível 2)
        const level2Inviter = await prisma.user.findUnique({
            where: { id: inviterId },
            select: { inviter_id: true }
        });

        if (level2Inviter && level2Inviter.inviter_id) {
            await prisma.referralLevel.create({
                data: {
                    referrer_id: level2Inviter.inviter_id,
                    user_id: newUserId,
                    level: 2
                }
            });

            // Buscar o convidador do nível 2 (nível 3)
            const level3Inviter = await prisma.user.findUnique({
                where: { id: level2Inviter.inviter_id },
                select: { inviter_id: true }
            });

            if (level3Inviter && level3Inviter.inviter_id) {
                await prisma.referralLevel.create({
                    data: {
                        referrer_id: level3Inviter.inviter_id,
                        user_id: newUserId,
                        level: 3
                    }
                });
            }
        }
    } catch (error) {
        console.error('Erro ao criar rede de referência:', error);
    }
}

// Rota para verificar código de convite (pública)
app.get('/invitation/:code/verify', async (req, res) => {
    // ... (código anterior mantido igual)
});

// TODAS AS ROTAS ABAIXO SÃO PROTEGIDAS ===============================

// Rota para obter informações do usuário (protegida)

// Middleware authorizeUser
const authorizeUser = (req, res, next) => {
  try {
    const userId = req.params.id;
    const tokenUserId = req.user?.id; // vem do authenticateToken

    // Permite acesso se for o próprio usuário ou um admin2
    if (userId === tokenUserId || req.user?.role === 'admin2') {
      next();
    } else {
      res.status(403).json({
        success: false,
        message: 'Acesso negado: não autorizado'
      });
    }
  } catch (err) {
    console.error('Erro em authorizeUser:', err);
    res.status(500).json({
      success: false,
      message: 'Erro ao verificar autorização'
    });
  }
};


app.get('/user/:id', authenticateToken, authorizeUser, async (req, res) => {
    try {
        const userId = req.params.id;
        
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                mobile: true,
                saldo: true,
                invitation_code: true,
                created_at: true,
                inviter_id: true
            }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        res.json({
            success: true,
            data: user
        });

    } catch (error) {
        console.error('Erro ao buscar usuário:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para obter informações completas do usuário (protegida)
app.get('/user/:id/full-profile', authenticateToken, authorizeUser, async (req, res) => {
    try {
        const userId = req.params.id;
        
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                mobile: true,
                 nickname: true,     // Adicione esta linha
                sex: true,          // Adicione esta linha
                head_img: true,     // Adicione esta linhac
                saldo: true,
                invitation_code: true,
                created_at: true,
                updated_at: true,
                inviter_id: true,
            }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        let inviterInfo = null;
        if (user.inviter_id) {
            inviterInfo = await prisma.user.findUnique({
                where: { id: user.inviter_id },
                select: {
                    id: true,
                    mobile: true,
                    invitation_code: true
                }
            });
        }

        const referralNetwork = await prisma.referralLevel.findMany({
            where: { referrer_id: userId },
            include: {
                user: {
                    select: {
                        id: true,
                        mobile: true,
                        saldo: true,
                        invitation_code: true,
                        created_at: true
                    }
                }
            },
            orderBy: {
                level: 'asc'
            }
        });

        const organizedReferrals = {
            level1: referralNetwork.filter(item => item.level === 1).map(item => item.user),
            level2: referralNetwork.filter(item => item.level === 2).map(item => item.user),
            level3: referralNetwork.filter(item => item.level === 3).map(item => item.user)
        };

        const referralCounts = {
            level1: organizedReferrals.level1.length,
            level2: organizedReferrals.level2.length,
            level3: organizedReferrals.level3.length,
            total: organizedReferrals.level1.length + organizedReferrals.level2.length + organizedReferrals.level3.length
        };

        const userProfile = {
            user_info: {
                ...user,
                inviter: inviterInfo
            },
            referral_network: {
                levels: organizedReferrals,
                counts: referralCounts
            },
            statistics: {
                total_balance: user.saldo,
                total_referrals: referralCounts.total,
                registration_date: user.created_at,
                account_age_days: Math.floor((new Date() - new Date(user.created_at)) / (1000 * 60 * 60 * 24))
            }
        };

        res.json({
            success: true,
            message: 'Perfil completo obtido com sucesso',
            data: userProfile
        });

    } catch (error) {
        console.error('Erro ao buscar perfil completo:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para obter rede de indicação (protegida)
app.get('/user/:id/referral-network', authenticateToken, authorizeUser, async (req, res) => {
    try {
        const userId = req.params.id;
        
        const level1Referrals = await prisma.user.findMany({
            where: { inviter_id: userId },
            select: {
                id: true,
                mobile: true,
                saldo: true,
                invitation_code: true,
                created_at: true
            }
        });

        const level2Users = await prisma.user.findMany({
            where: {
                inviter_id: {
                    in: level1Referrals.map(user => user.id)
                }
            },
            select: {
                id: true,
                mobile: true,
                saldo: true,
                invitation_code: true,
                created_at: true,
                inviter_id: true
            }
        });

        const level3Users = await prisma.user.findMany({
            where: {
                inviter_id: {
                    in: level2Users.map(user => user.id)
                }
            },
            select: {
                id: true,
                mobile: true,
                saldo: true,
                invitation_code: true,
                created_at: true
            }
        });

        res.json({
            success: true,
            data: {
                level1: level1Referrals,
                level2: level2Users,
                level3: level3Users,
                total: level1Referrals.length + level2Users.length + level3Users.length
            }
        });

    } catch (error) {
        console.error('Erro ao buscar rede de indicação:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para listar todos os convidados (protegida)
app.get('/user/:id/all-referrals', authenticateToken, authorizeUser, async (req, res) => {
    try {
        const userId = req.params.id;
        
        const network = await prisma.referralLevel.findMany({
            where: {
                referrer_id: userId
            },
            include: {
                user: {
                    select: {
                        id: true,
                        mobile: true,
                        saldo: true,
                        invitation_code: true,
                        created_at: true
                    }
                }
            },
            orderBy: {
                level: 'asc'
            }
        });

        const organizedData = {
            level1: network.filter(item => item.level === 1).map(item => item.user),
            level2: network.filter(item => item.level === 2).map(item => item.user),
            level3: network.filter(item => item.level === 3).map(item => item.user)
        };

        res.json({
            success: true,
            data: organizedData
        });

    } catch (error) {
        console.error('Erro ao buscar todos os convidados:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para atualizar usuário (protegida)
app.put('/user/:id', authenticateToken, authorizeUser, async (req, res) => {
    try {
        const userId = req.params.id;
        const { mobile, password, pay_password } = req.body;
        
        const updateData = { updated_at: new Date() };
        
        if (mobile) updateData.mobile = mobile;
        if (password) updateData.password = await bcrypt.hash(password, 10);
        if (pay_password) updateData.pay_password = await bcrypt.hash(pay_password, 10);

        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: updateData,
            select: {
                id: true,
                mobile: true,
                saldo: true,
                invitation_code: true,
                updated_at: true
            }
        });

        res.json({
            success: true,
            message: 'Usuário atualizado com sucesso',
            data: updatedUser
        });

    } catch (error) {
        console.error('Erro ao atualizar usuário:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para deletar usuário (protegida - cuidado com essa rota!)
app.delete('/user/:id', authenticateToken, authorizeUser, async (req, res) => {
    try {
        const userId = req.params.id;
        
        await prisma.user.delete({
            where: { id: userId }
        });

        res.json({
            success: true,
            message: 'Usuário deletado com sucesso'
        });

    } catch (error) {
        console.error('Erro ao deletar usuário:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Adicione estas rotas ao seu arquivo server.js

// Rota para atualizar informações do usuário (apelido, sexo, avatar)
app.put('/user/profile/update', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { nickname, sex, head_img } = req.body;
        
        const updateData = { updated_at: new Date() };
        
        if (nickname) updateData.nickname = nickname;
        if (sex) updateData.sex = sex;
        if (head_img) updateData.head_img = head_img;

        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: updateData,
            select: {
                id: true,
                mobile: true,
                nickname: true,
                sex: true,
                head_img: true,
                saldo: true,
                invitation_code: true,
                updated_at: true
            }
        });

        res.json({
            success: true,
            message: 'Informações atualizadas com sucesso',
            data: updatedUser
        });

    } catch (error) {
        console.error('Erro ao atualizar informações do usuário:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});



// ==============================================
// ROTA PARA TRANSACOES DO USUÁRIO AUTENTICADO
// ==============================================

// Rota para obter transações do usuário autenticado
app.get('/api/user/transactions', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { page = 1, limit = 100, type } = req.query;
        
        console.log(`📊 Buscando transações para usuário: ${userId}`);
        
        // Construir filtro
        const whereClause = { user_id: userId };
        if (type) {
            whereClause.type = type;
        }
        
        // Buscar transações
        const transactions = await prisma.transaction.findMany({
            where: whereClause,
            orderBy: { created_at: 'desc' },
            skip: (parseInt(page) - 1) * parseInt(limit),
            take: parseInt(limit),
            select: {
                id: true,
                type: true,
                amount: true,
                description: true,
                balance_after: true,
                created_at: true
            }
        });
        
        // Contar total
        const total = await prisma.transaction.count({
            where: whereClause
        });
        
        console.log(`✅ Encontradas ${transactions.length} transações para usuário ${userId}`);
        
        res.json({
            success: true,
            data: {
                transactions,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / parseInt(limit))
                }
            }
        });
        
    } catch (error) {
        console.error('❌ Erro ao buscar transações do usuário:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para alterar senha
app.put('/user/password/update', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { current_password, new_password } = req.body;
        
        if (!current_password || !new_password) {
            return res.status(400).json({
                success: false,
                message: 'Senha atual e nova senha são obrigatórias'
            });
        }

        // Buscar usuário para verificar a senha atual
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { password: true }
        });

        if (!user || !(await bcrypt.compare(current_password, user.password))) {
            return res.status(401).json({
                success: false,
                message: 'Senha atual incorreta'
            });
        }

        // Atualizar senha
        const hashedPassword = await bcrypt.hash(new_password, 10);
        
        await prisma.user.update({
            where: { id: userId },
            data: {
                password: hashedPassword,
                updated_at: new Date()
            }
        });

        res.json({
            success: true,
            message: 'Senha alterada com sucesso'
        });

    } catch (error) {
        console.error('Erro ao alterar senha:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para alterar senha de pagamento
app.put('/user/pay-password/update', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { current_pay_password, new_pay_password } = req.body;
        
        if (!current_pay_password || !new_pay_password) {
            return res.status(400).json({
                success: false,
                message: 'Senha de pagamento atual e nova senha são obrigatórias'
            });
        }

        // Buscar usuário para verificar a senha de pagamento atual
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { pay_password: true }
        });

        if (!user || !(await bcrypt.compare(current_pay_password, user.pay_password))) {
            return res.status(401).json({
                success: false,
                message: 'Senha de pagamento atual incorreta'
            });
        }

        // Atualizar senha de pagamento
        const hashedPayPassword = await bcrypt.hash(new_pay_password, 10);
        
        await prisma.user.update({
            where: { id: userId },
            data: {
                pay_password: hashedPayPassword,
                updated_at: new Date()
            }
        });

        res.json({
            success: true,
            message: 'Senha de pagamento alterada com sucesso'
        });

    } catch (error) {
        console.error('Erro ao alterar senha de pagamento:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para obter informações da conta bancária
app.get('/user/bank-account', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const bankAccount = await prisma.bankAccount.findUnique({
            where: { user_id: userId },
            select: {
                id: true,
                bank_name: true,
                account_holder: true,
                account_number: true,
                branch_code: true,
                created_at: true,
                updated_at: true
            }
        });

        res.json({
            success: true,
            data: bankAccount || null
        });

    } catch (error) {
        console.error('Erro ao buscar informações da conta bancária:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para fazer logout (invalida o token)
app.post('/logout', authenticateToken, async (req, res) => {
    try {
        // Em uma implementação mais robusta, você poderia adicionar o token a uma blacklist
        // Por enquanto, apenas retornamos sucesso e o cliente remove o token do localStorage
        
        res.json({
            success: true,
            message: 'Logout realizado com sucesso'
        });

    } catch (error) {
        console.error('Erro no logout:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para fazer check-in
app.post('/api/checkin', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        // Verificar se já fez check-in hoje
        const existingCheckin = await prisma.dailyCheckin.findFirst({
            where: {
                user_id: userId,
                checkin_date: {
                    gte: today,
                    lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
                }
            }
        });
        
        if (existingCheckin) {
            return res.status(400).json({
                success: false,
                message: 'Você já fez check-in hoje. Volte amanhã!'
            });
        }
        
        // Calcular próximo horário de check-in (amanhã às 00:00)
        const nextCheckin = new Date(today);
        nextCheckin.setDate(nextCheckin.getDate() + 1);
        
        // Criar registro de check-in
        await prisma.dailyCheckin.create({
            data: {
                user_id: userId,
                checkin_date: new Date(),
                amount_received: 10,
                next_checkin: nextCheckin
            }
        });
        
        // Adicionar saldo ao usuário
        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: {
                saldo: {
                    increment: 10
                }
            },
            select: {
                saldo: true
            }
        });
        
        res.json({
            success: true,
            message: 'Check-in realizado com sucesso! +10 KZ adicionados.',
            data: {
                new_balance: updatedUser.saldo,
                next_checkin: nextCheckin
            }
        });
        
    } catch (error) {
        console.error('Erro no check-in:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para verificar status do check-in
app.get('/api/checkin/status', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        // Buscar check-in de hoje
        const todayCheckin = await prisma.dailyCheckin.findFirst({
            where: {
                user_id: userId,
                checkin_date: {
                    gte: today,
                    lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
                }
            },
            orderBy: {
                checkin_date: 'desc'
            }
        });
        
        if (todayCheckin) {
            // Já fez check-in hoje
            const nextCheckin = new Date(todayCheckin.next_checkin);
            res.json({
                success: true,
                data: {
                    can_checkin: false,
                    last_checkin: todayCheckin.checkin_date,
                    next_checkin: nextCheckin,
                    amount_received: todayCheckin.amount_received
                }
            });
        } else {
            // Pode fazer check-in
            const nextCheckin = new Date(today);
            nextCheckin.setDate(nextCheckin.getDate() + 1);
            
            res.json({
                success: true,
                data: {
                    can_checkin: true,
                    next_checkin: nextCheckin
                }
            });
        }
        
    } catch (error) {
        console.error('Erro ao verificar status do check-in:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para obter histórico de check-ins
app.get('/api/checkin/history', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { page = 1, limit = 30 } = req.query;
        
        const checkins = await prisma.dailyCheckin.findMany({
            where: { user_id: userId },
            orderBy: { checkin_date: 'desc' },
            skip: (parseInt(page) - 1) * parseInt(limit),
            take: parseInt(limit),
            select: {
                id: true,
                checkin_date: true,
                amount_received: true
            }
        });
        
        const total = await prisma.dailyCheckin.count({
            where: { user_id: userId }
        });
        
        res.json({
            success: true,
            data: {
                checkins,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / parseInt(limit))
                }
            }
        });
        
    } catch (error) {
        console.error('Erro ao buscar histórico de check-ins:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para obter perfil do usuário
app.get('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                mobile: true,
                saldo: true,
                invitation_code: true,
                created_at: true,
                updated_at: true
            }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        res.json({
            success: true,
            data: {
                user_id: user.id,
                mobile: user.mobile,
                wallet_balance: user.saldo,
                invitation_code: user.invitation_code,
                created_at: user.created_at,
                updated_at: user.updated_at
            }
        });

    } catch (error) {
        console.error('Erro ao buscar perfil do usuário:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para realizar compra com sistema de bônus em 3 níveis (COMPLETAMENTE CORRIGIDA)
app.post('/api/purchase', authenticateToken, async (req, res) => {
    let transaction;
    try {
        const userId = req.user.id;
        const { product_id, product_name, amount, quantity, daily_return, cycle_days } = req.body;

        console.log('=== 🛒 NOVA COMPRA INICIADA ===');
        console.log('Usuário:', userId);
        console.log('Produto:', product_name);
        console.log('Valor:', amount);

        // Validar dados
        if (!product_id || !product_name || !amount) {
            return res.status(400).json({
                success: false,
                message: 'Dados da compra incompletos'
            });
        }

        // Buscar usuário e saldo
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { 
                id: true, 
                saldo: true, 
                mobile: true,
                inviter_id: true
            }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        console.log(`📊 Saldo atual do usuário ${user.mobile}: ${user.saldo} KZ`);
        console.log(`💳 Valor da compra: ${amount} KZ`);

        // Verificar saldo suficiente
        if (user.saldo < amount) {
            return res.status(400).json({
                success: false,
                message: `Saldo insuficiente. Saldo atual: ${user.saldo} KZ, Valor necessário: ${amount} KZ`
            });
        }

        // Calcular data do próximo rendimento (24 HORAS)
        const nextPayout = new Date();
        nextPayout.setHours(nextPayout.getHours() + 24);

        // Calcular data de expiração
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + (cycle_days || 30));

        let purchase, updatedUser, transactionRecord;
        
        try {
            // Iniciar transação principal
            console.log('🔄 Iniciando transação de compra...');
            transaction = await prisma.$transaction(async (tx) => {

                // 1. Deduzir saldo do usuário
                updatedUser = await tx.user.update({
                    where: { id: userId },
                    data: {
                        saldo: {
                            decrement: amount
                        }
                    },
                    select: {
                        saldo: true
                    }
                });

                console.log('✅ Saldo após dedução:', updatedUser.saldo);

                // 2. Registrar a compra
                purchase = await tx.purchase.create({
                    data: {
                        user_id: userId,
                        product_id: product_id.toString(),
                        product_name: product_name,
                        amount: amount,
                        quantity: quantity || 1,
                        daily_return: daily_return || 13,
                        cycle_days: cycle_days || 30,
                        purchase_date: new Date(),
                        next_payout: nextPayout,
                        expiry_date: expiryDate,
                        status: 'active',
                        total_earned: 0,
                        payout_count: 0
                    }
                });

                console.log('✅ Compra registrada:', purchase.id);

                // 3. Registrar no histórico de transações
                transactionRecord = await tx.transaction.create({
                    data: {
                        user_id: userId,
                        type: 'purchase',
                        amount: -amount,
                        description: `Compra: ${product_name} - ${quantity || 1}x`,
                        balance_after: updatedUser.saldo,
                        created_at: new Date()
                    }
                });

                console.log('✅ Transação registrada:', transactionRecord.id);

                return {
                    purchase: purchase,
                    updatedUser: updatedUser,
                    transaction: transactionRecord
                };
            });

            console.log('✅ Transação principal concluída com sucesso');

        } catch (transactionError) {
            console.error('❌ Erro na transação principal:', transactionError);
            throw new Error(`Falha na transação: ${transactionError.message}`);
        }

        // DISTRIBUIR BÔNUS PARA A REDE
        console.log('🎁 INICIANDO DISTRIBUIÇÃO DE BÔNUS...');
        let bonusResults = {
            level1: 0,
            level2: 0,
            level3: 0,
            total: 0,
            details: []
        };

        try {
            bonusResults = await distributeReferralBonuses(prisma, userId, amount);
            console.log('✅ Distribuição de bônus concluída:', bonusResults);
        } catch (bonusError) {
            console.error('⚠️ Erro na distribuição de bônus (não crítico):', bonusError);
            // Não falha a compra se o bônus der erro
        }

        // Registrar log do sistema
        await prisma.systemLog.create({
            data: {
                action: 'PURCHASE_COMPLETED',
                description: `Usuário ${user.mobile} comprou ${product_name} por ${amount} KZ. Bônus distribuídos: N1: ${bonusResults.level1}, N2: ${bonusResults.level2}, N3: ${bonusResults.level3}`,
                user_id: userId,
                created_at: new Date()
            }
        });

        // Buscar saldo atualizado para confirmar
        const finalUser = await prisma.user.findUnique({
            where: { id: userId },
            select: { saldo: true, mobile: true }
        });

        console.log('💰 Saldo final confirmado:', finalUser.saldo, 'KZ');
        console.log('=== 🎉 COMPRA CONCLUÍDA COM SUCESSO ===');

        res.json({
            success: true,
            message: 'Compra realizada com sucesso!' + (bonusResults.total > 0 ? ' Bônus distribuídos para sua rede.' : ''),
            data: {
                purchase_id: purchase.id,
                new_balance: updatedUser.saldo,
                confirmed_balance: finalUser.saldo,
                next_payout: purchase.next_payout,
                daily_return: purchase.daily_return,
                expiry_date: purchase.expiry_date,
                bonuses_distributed: bonusResults
            }
        });

    } catch (error) {
        console.error('❌ ERRO GERAL na compra:', error);
        
        if (error.message.includes('saldo')) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }

        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor: ' + error.message
        });
    }
});

// FUNÇÃO DISTRIBUTE REFERRAL BONUSES CORRIGIDA - COM OS PERCENTUAIS CORRETOS
async function distributeReferralBonuses(tx, purchaserId, purchaseAmount) {
    console.log('=== 🎁 INICIANDO DISTRIBUIÇÃO DE BÔNUS ===');
    console.log('👤 Comprador ID:', purchaserId);
    console.log('💰 Valor da compra:', purchaseAmount, 'KZ');

    const bonusResults = {
        level1: 0,
        level2: 0,
        level3: 0,
        total: 0,
        details: []
    };

    try {
        // PASSO 1: Buscar a rede de patrocinadores (quem convidou o comprador)
        const purchaserReferrers = await tx.referralLevel.findMany({
            where: { 
                user_id: purchaserId // Quem convidou este comprador
            },
            include: {
                referrer: {
                    select: {
                        id: true,
                        mobile: true,
                        saldo: true,
                        invitation_code: true
                    }
                }
            },
            orderBy: { level: 'asc' }
        });

        console.log('🔍 Rede de patrocinadores encontrada:', purchaserReferrers.length, 'níveis');
        
        if (purchaserReferrers.length === 0) {
            console.log('ℹ️ Nenhum patrocinador encontrado para este comprador');
            return bonusResults;
        }

        // ✅✅✅ PERCENTUAIS CORRETOS - 25%, 2%, 1% ✅✅✅
        const bonusPercentages = {
            1: 0.25, // ✅ 25% para nível 1
            2: 0.02, // ✅ 2% para nível 2  
            3: 0.01  // ✅ 1% para nível 3
        };

        // PASSO 2: Distribuir bônus para os patrocinadores
        for (const referral of purchaserReferrers) {
            const level = referral.level;
            const bonusPercentage = bonusPercentages[level];
            const sponsor = referral.referrer;
            
            if (bonusPercentage && sponsor) {
                const bonusAmount = Math.floor(purchaseAmount * bonusPercentage);
                
                if (bonusAmount > 0) {
                    console.log(`\n🔄 Processando bônus nível ${level} para: ${sponsor.mobile}`);
                    console.log(`📊 Valor do bônus: ${bonusAmount} KZ (${bonusPercentage * 100}% de ${purchaseAmount} KZ)`);
                    
                    try {
                        // Buscar saldo atual do patrocinador
                        const currentSponsor = await tx.user.findUnique({
                            where: { id: sponsor.id },
                            select: { saldo: true }
                        });

                        console.log(`💳 Saldo anterior do patrocinador: ${currentSponsor.saldo} KZ`);

                        // Atualizar saldo do patrocinador
                        const updatedSponsor = await tx.user.update({
                            where: { id: sponsor.id },
                            data: {
                                saldo: {
                                    increment: bonusAmount
                                }
                            },
                            select: {
                                saldo: true,
                                mobile: true
                            }
                        });

                        console.log(`✅ Saldo atualizado: ${sponsor.mobile} = ${updatedSponsor.saldo} KZ (+${bonusAmount} KZ)`);

                        // Registrar transação do patrocinador
                        const sponsorTransaction = await tx.transaction.create({
                            data: {
                                user_id: sponsor.id,
                                type: 'referral_bonus',
                                amount: bonusAmount,
                                description: `Bônus nível ${level} - Compra de ${purchaseAmount} KZ`,
                                balance_after: updatedSponsor.saldo,
                                created_at: new Date()
                            }
                        });

                        console.log(`📝 Transação registrada: ${sponsorTransaction.id}`);

                        // Registrar bônus na tabela de referência
                        const referralBonus = await tx.referralBonus.create({
                            data: {
                                referrer_id: sponsor.id, // Quem recebe o bônus
                                referred_user_id: purchaserId, // Quem fez a compra
                                level: level,
                                purchase_amount: purchaseAmount,
                                bonus_amount: bonusAmount,
                                bonus_percentage: bonusPercentage * 100,
                                purchase_description: `Compra de ${purchaseAmount} KZ`,
                                created_at: new Date()
                            }
                        });

                        console.log(`🎯 Bônus registrado: ${referralBonus.id}`);

                        // Atualizar resultados
                        bonusResults[`level${level}`] += bonusAmount;
                        bonusResults.total += bonusAmount;
                        bonusResults.details.push({
                            level: level,
                            sponsor_id: sponsor.id,
                            sponsor_mobile: sponsor.mobile,
                            sponsor_code: sponsor.invitation_code,
                            amount: bonusAmount,
                            percentage: bonusPercentage * 100,
                            timestamp: new Date()
                        });

                        console.log(`✅ Bônus nível ${level} processado com sucesso`);

                    } catch (error) {
                        console.error(`❌ Erro no nível ${level} para ${sponsor.mobile}:`, error);
                        // Continua para o próximo patrocinador
                    }
                } else {
                    console.log(`⚠️ Bônus nível ${level} é zero para ${sponsor.mobile}`);
                }
            } else {
                console.log(`⚠️ Percentual de bônus não encontrado para nível ${level}`);
            }
        }

        console.log('=== 🎉 DISTRIBUIÇÃO DE BÔNUS CONCLUÍDA ===');
        console.log('📈 Resultado final:', bonusResults);
        return bonusResults;

    } catch (error) {
        console.error('❌ ERRO GERAL na distribuição de bônus:', error);
        return bonusResults;
    }
}

// Rota de debug para verificar a rede de referência
app.get('/api/debug/referral-network/:userId', authenticateToken, async (req, res) => {
    try {
        const userId = req.params.userId;
        
        // Verificar como referrer (quem o usuário convidou)
        const asReferrer = await prisma.referralLevel.findMany({
            where: { referrer_id: userId },
            include: {
                user: {
                    select: {
                        id: true,
                        mobile: true,
                        saldo: true,
                        invitation_code: true
                    }
                }
            }
        });

        // Verificar como referred (quem convidou o usuário)
        const asReferred = await prisma.referralLevel.findMany({
            where: { user_id: userId },
            include: {
                referrer: {
                    select: {
                        id: true,
                        mobile: true,
                        saldo: true,
                        invitation_code: true
                    }
                }
            }
        });

        res.json({
            success: true,
            data: {
                user_id: userId,
                as_referrer: {
                    count: asReferrer.length,
                    members: asReferrer.map(r => ({
                        level: r.level,
                        user_id: r.user_id,
                        mobile: r.user.mobile,
                        saldo: r.user.saldo,
                        code: r.user.invitation_code
                    }))
                },
                as_referred: {
                    count: asReferred.length,
                    sponsors: asReferred.map(r => ({
                        level: r.level,
                        sponsor_id: r.referrer_id,
                        sponsor_mobile: r.referrer.mobile,
                        sponsor_saldo: r.referrer.saldo,
                        sponsor_code: r.referrer.invitation_code
                    }))
                }
            }
        });

    } catch (error) {
        console.error('Erro no debug:', error);
        res.status(500).json({ success: false, message: 'Erro no debug' });
    }
});

// Rota para verificar bônus distribuídos
app.get('/api/debug/bonus-history/:userId', authenticateToken, async (req, res) => {
    try {
        const userId = req.params.userId;
        
        const bonusesGiven = await prisma.referralBonus.findMany({
            where: { referrer_id: userId },
            include: {
                referred_user: {
                    select: { mobile: true, invitation_code: true }
                }
            },
            orderBy: { created_at: 'desc' }
        });

        const bonusesReceived = await prisma.referralBonus.findMany({
            where: { referred_user_id: userId },
            include: {
                referrer: {
                    select: { mobile: true, invitation_code: true }
                }
            },
            orderBy: { created_at: 'desc' }
        });

        res.json({
            success: true,
            data: {
                bonuses_given: {
                    count: bonusesGiven.length,
                    total: bonusesGiven.reduce((sum, b) => sum + b.bonus_amount, 0),
                    details: bonusesGiven
                },
                bonuses_received: {
                    count: bonusesReceived.length,
                    total: bonusesReceived.reduce((sum, b) => sum + b.bonus_amount, 0),
                    details: bonusesReceived
                }
            }
        });

    } catch (error) {
        console.error('Erro no debug de bônus:', error);
        res.status(500).json({ success: false, message: 'Erro no debug' });
    }
});

// Rota de debug para verificar a rede de referência
app.get('/api/debug/referral-network/:userId', authenticateToken, async (req, res) => {
    try {
        const userId = req.params.userId;
        
        // Verificar como referrer (quem o usuário convidou)
        const asReferrer = await prisma.referralLevel.findMany({
            where: { referrer_id: userId },
            include: {
                user: {
                    select: {
                        id: true,
                        mobile: true,
                        saldo: true,
                        invitation_code: true
                    }
                }
            }
        });

        // Verificar como referred (quem convidou o usuário)
        const asReferred = await prisma.referralLevel.findMany({
            where: { user_id: userId },
            include: {
                referrer: {
                    select: {
                        id: true,
                        mobile: true,
                        saldo: true,
                        invitation_code: true
                    }
                }
            }
        });

        res.json({
            success: true,
            data: {
                user_id: userId,
                as_referrer: {
                    count: asReferrer.length,
                    members: asReferrer.map(r => ({
                        level: r.level,
                        user_id: r.user_id,
                        mobile: r.user.mobile,
                        saldo: r.user.saldo,
                        code: r.user.invitation_code
                    }))
                },
                as_referred: {
                    count: asReferred.length,
                    sponsors: asReferred.map(r => ({
                        level: r.level,
                        sponsor_id: r.referrer_id,
                        sponsor_mobile: r.referrer.mobile,
                        sponsor_saldo: r.referrer.saldo,
                        sponsor_code: r.referrer.invitation_code
                    }))
                }
            }
        });

    } catch (error) {
        console.error('Erro no debug:', error);
        res.status(500).json({ success: false, message: 'Erro no debug' });
    }
});

// Rota para verificar bônus distribuídos
app.get('/api/debug/bonus-history/:userId', authenticateToken, async (req, res) => {
    try {
        const userId = req.params.userId;
        
        const bonusesGiven = await prisma.referralBonus.findMany({
            where: { referrer_id: userId },
            include: {
                referred_user: {
                    select: { mobile: true, invitation_code: true }
                }
            },
            orderBy: { created_at: 'desc' }
        });

        const bonusesReceived = await prisma.referralBonus.findMany({
            where: { referred_user_id: userId },
            include: {
                referrer: {
                    select: { mobile: true, invitation_code: true }
                }
            },
            orderBy: { created_at: 'desc' }
        });

        res.json({
            success: true,
            data: {
                bonuses_given: {
                    count: bonusesGiven.length,
                    total: bonusesGiven.reduce((sum, b) => sum + b.bonus_amount, 0),
                    details: bonusesGiven
                },
                bonuses_received: {
                    count: bonusesReceived.length,
                    total: bonusesReceived.reduce((sum, b) => sum + b.bonus_amount, 0),
                    details: bonusesReceived
                }
            }
        });

    } catch (error) {
        console.error('Erro no debug de bônus:', error);
        res.status(500).json({ success: false, message: 'Erro no debug' });
    }
});


// Rota para processar rendimentos automáticos (CORRIGIDA)
app.post('/api/process-payouts', async (req, res) => {
    try {
        const now = new Date();
        console.log(`${now.toISOString()} - Iniciando processamento de rendimentos`);
        
        // Buscar compras ativas com payout devido
        const duePurchases = await prisma.purchase.findMany({
            where: {
                status: 'active',
                next_payout: {
                    lte: now
                },
                expiry_date: {
                    gt: now
                }
            },
            include: {
                user: {
                    select: {
                        id: true,
                        mobile: true,
                        saldo: true
                    }
                }
            }
        });

        console.log(`Encontradas ${duePurchases.length} compras para processar`);

        let processedCount = 0;
        let totalAmount = 0;
        const results = [];

        for (const purchase of duePurchases) {
            try {
                // Calcular próximo payout (24 HORAS)
                const nextPayout = new Date();
                nextPayout.setHours(nextPayout.getHours() + 24);

                // Verificar se atingiu o limite de dias
                const daysPassed = Math.floor((now - purchase.purchase_date) / (1000 * 60 * 60 * 24));
                const remainingDays = (purchase.cycle_days || 30) - daysPassed;

                if (remainingDays <= 0) {
                    // Finalizar o produto
                    await prisma.purchase.update({
                        where: { id: purchase.id },
                        data: {
                            status: 'completed',
                            completed_at: new Date()
                        }
                    });

                    results.push({
                        purchase_id: purchase.id,
                        user_id: purchase.user_id,
                        status: 'completed',
                        message: 'Produto completou o ciclo de 30 dias'
                    });
                    continue;
                }

                // Valor do rendimento diário
                const dailyReturn = purchase.daily_return || 13;

                console.log(`Processando rendimento para usuário ${purchase.user.mobile}: +${dailyReturn} KZ`);

                // Processar transação CORRIGIDA
                await prisma.$transaction(async (tx) => {
                    // 1. Buscar saldo atual
                    const currentUser = await tx.user.findUnique({
                        where: { id: purchase.user_id },
                        select: { saldo: true }
                    });

                    // 2. Adicionar rendimento ao saldo
                    const updatedUser = await tx.user.update({
                        where: { id: purchase.user_id },
                        data: {
                            saldo: {
                                increment: dailyReturn
                            }
                        },
                        select: {
                            saldo: true
                        }
                    });

                    console.log(`Saldo atualizado: ${currentUser.saldo} → ${updatedUser.saldo} KZ`);

                    // 3. Atualizar purchase
                    await tx.purchase.update({
                        where: { id: purchase.id },
                        data: {
                            next_payout: nextPayout,
                            total_earned: {
                                increment: dailyReturn
                            },
                            payout_count: {
                                increment: 1
                            },
                            last_payout: new Date()
                        }
                    });

                    // 4. Registrar transação
                    await tx.transaction.create({
                        data: {
                            user_id: purchase.user_id,
                            type: 'payout',
                            amount: dailyReturn,
                            description: `Rendimento diário: ${purchase.product_name}`,
                            balance_after: updatedUser.saldo,
                            created_at: new Date()
                        }
                    });

                    // 5. Registrar log
                    await tx.systemLog.create({
                        data: {
                            action: 'DAILY_PAYOUT',
                            description: `Rendimento de ${dailyReturn} KZ para ${purchase.user.mobile}. Saldo: ${updatedUser.saldo} KZ`,
                            user_id: purchase.user_id,
                            created_at: new Date()
                        }
                    });
                });

                processedCount++;
                totalAmount += dailyReturn;
                results.push({
                    purchase_id: purchase.id,
                    user_id: purchase.user_id,
                    amount: dailyReturn,
                    next_payout: nextPayout,
                    status: 'success'
                });

            } catch (purchaseError) {
                console.error(`Erro processando purchase ${purchase.id}:`, purchaseError);
                results.push({
                    purchase_id: purchase.id,
                    user_id: purchase.user_id,
                    status: 'error',
                    error: purchaseError.message
                });
            }
        }

        console.log(`Processamento concluído: ${processedCount} rendimentos, total: ${totalAmount} KZ`);

        res.json({
            success: true,
            message: `Processados ${processedCount} rendimentos. Total: ${totalAmount} KZ`,
            data: {
                processed: processedCount,
                total_amount: totalAmount,
                results: results
            }
        });

    } catch (error) {
        console.error('Erro ao processar rendimentos:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para verificar status do check-in/tarefas
app.get('/api/tasks/status', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        // Verificar se usuário tem compras ativas
        const activePurchases = await prisma.purchase.findMany({
            where: {
                user_id: userId,
                status: 'active',
                expiry_date: {
                    gt: new Date()
                }
            },
            select: {
                id: true,
                product_name: true,
                daily_return: true,
                total_earned: true
            }
        });

        const hasActivePurchases = activePurchases.length > 0;
        
        // Verificar status das tarefas de hoje
        const todayTasks = await prisma.dailyTask.findMany({
            where: {
                user_id: userId,
                task_date: {
                    gte: today,
                    lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
                }
            }
        });

        const checkinCompleted = todayTasks.some(task => task.task_type === 'daily_checkin');
        const productIncomeCompleted = todayTasks.some(task => task.task_type === 'product_income');

        // Buscar ou criar status do usuário
        let userTaskStatus = await prisma.userTaskStatus.findUnique({
            where: { user_id: userId }
        });

        if (!userTaskStatus) {
            userTaskStatus = await prisma.userTaskStatus.create({
                data: {
                    user_id: userId,
                    last_task_date: new Date(0), // Data muito antiga
                    daily_checkin_completed: false,
                    product_income_completed: false
                }
            });
        }

        // Verificar se é um novo dia (para resetar tarefas)
        const isNewDay = userTaskStatus.last_task_date < today;
        
        if (isNewDay) {
            // Resetar status para novo dia
            userTaskStatus = await prisma.userTaskStatus.update({
                where: { user_id: userId },
                data: {
                    last_task_date: new Date(),
                    daily_checkin_completed: false,
                    product_income_completed: false
                }
            });
        }

        res.json({
            success: true,
            data: {
                has_active_purchases: hasActivePurchases,
                active_purchases: activePurchases,
                tasks_status: {
                    daily_checkin: {
                        completed: checkinCompleted || userTaskStatus.daily_checkin_completed,
                        available: true, // Check-in sempre disponível
                        reward: 1
                    },
                    product_income: {
                        completed: productIncomeCompleted || userTaskStatus.product_income_completed,
                        available: hasActivePurchases, // Só disponível se tiver compras ativas
                        reward: activePurchases.reduce((sum, purchase) => sum + purchase.daily_return, 0),
                        purchases: activePurchases
                    }
                },
                today: today,
                can_perform_tasks: !checkinCompleted || !productIncomeCompleted
            }
        });

    } catch (error) {
        console.error('Erro ao verificar status das tarefas:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para verificar compras recentes do usuário
app.get('/api/user/recent-purchases', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const recentPurchases = await prisma.purchase.findMany({
            where: {
                user_id: userId,
                purchase_date: {
                    gte: today
                }
            },
            select: {
                id: true,
                product_name: true,
                amount: true,
                purchase_date: true,
                status: true
            },
            orderBy: {
                purchase_date: 'desc'
            }
        });

        res.json({
            success: true,
            data: {
                has_recent_purchases: recentPurchases.length > 0,
                recent_purchases: recentPurchases,
                count: recentPurchases.length
            }
        });

    } catch (error) {
        console.error('Erro ao verificar compras recentes:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Adicione esta rota ao seu server.js, após as outras rotas protegidas:

// Rota para obter estatísticas do usuário
app.get('/api/user/statistics', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Buscar totais de compras (investimento)
        const totalInvested = await prisma.purchase.aggregate({
            where: { user_id: userId },
            _sum: { amount: true }
        });

        // Buscar totais de saques
        const totalWithdrawals = await prisma.withdrawal.aggregate({
            where: { 
                user_id: userId,
                status: 'completed'
            },
            _sum: { amount: true }
        });

        // Buscar rendimentos de hoje
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const todayIncome = await prisma.transaction.aggregate({
            where: {
                user_id: userId,
                type: 'payout',
                created_at: {
                    gte: today
                }
            },
            _sum: { amount: true }
        });

        // Buscar rendimento total
        const totalEarnings = await prisma.transaction.aggregate({
            where: {
                user_id: userId,
                type: 'payout'
            },
            _sum: { amount: true }
        });

        res.json({
            success: true,
            data: {
                total_invested: totalInvested._sum.amount || 0,
                total_withdrawals: totalWithdrawals._sum.amount || 0,
                today_income: todayIncome._sum.amount || 0,
                total_earnings: totalEarnings._sum.amount || 0
            }
        });

    } catch (error) {
        console.error('Erro ao buscar estatísticas:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para realizar check-in diário
app.post('/api/tasks/daily-checkin', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Verificar se já fez check-in hoje
        const existingCheckin = await prisma.dailyTask.findFirst({
            where: {
                user_id: userId,
                task_type: 'daily_checkin',
                task_date: {
                    gte: today,
                    lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
                }
            }
        });

        if (existingCheckin) {
            return res.status(400).json({
                success: false,
                message: 'Você já fez check-in hoje. Volte amanhã!'
            });
        }

        const rewardAmount = 5;

        // Processar transação
        const result = await prisma.$transaction(async (tx) => {
            // 1. Adicionar saldo ao usuário
            const updatedUser = await tx.user.update({
                where: { id: userId },
                data: {
                    saldo: {
                        increment: rewardAmount
                    }
                },
                select: {
                    saldo: true,
                    mobile: true
                }
            });

            // 2. Registrar tarefa concluída
            const task = await tx.dailyTask.create({
                data: {
                    user_id: userId,
                    task_date: new Date(),
                    task_type: 'daily_checkin',
                    amount: rewardAmount,
                    description: 'Check-in diário realizado',
                    status: 'completed'
                }
            });

            // 3. Atualizar status do usuário
            await tx.userTaskStatus.upsert({
                where: { user_id: userId },
                update: {
                    daily_checkin_completed: true,
                    updated_at: new Date()
                },
                create: {
                    user_id: userId,
                    daily_checkin_completed: true,
                    product_income_completed: false,
                    last_task_date: new Date()
                }
            });

            // 4. Registrar transação
            await tx.transaction.create({
                data: {
                    user_id: userId,
                    type: 'daily_checkin',
                    amount: rewardAmount,
                    description: 'Recompensa de check-in diário',
                    balance_after: updatedUser.saldo,
                    created_at: new Date()
                }
            });

            // 5. Registrar log
            await tx.systemLog.create({
                data: {
                    action: 'DAILY_CHECKIN',
                    description: `Usuário ${updatedUser.mobile} realizou check-in diário. +${rewardAmount} KZ`,
                    user_id: userId,
                    created_at: new Date()
                }
            });

            return {
                new_balance: updatedUser.saldo,
                task: task
            };
        });

        res.json({
            success: true,
            message: 'Check-in realizado com sucesso! +5 KZ adicionados.',
            data: {
                new_balance: result.new_balance,
                reward: rewardAmount,
                next_checkin: new Date(today.getTime() + 24 * 60 * 60 * 1000) // Amanhã
            }
        });

    } catch (error) {
        console.error('Erro no check-in diário:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para coletar rendimentos dos produtos (Realizar Tarefas)
app.post('/api/tasks/collect-product-income', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Verificar se já coletou rendimentos hoje
        const existingCollection = await prisma.dailyTask.findFirst({
            where: {
                user_id: userId,
                task_type: 'product_income',
                task_date: {
                    gte: today,
                    lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
                }
            }
        });

        if (existingCollection) {
            return res.status(400).json({
                success: false,
                message: 'Você já coletou os rendimentos hoje. Volte amanhã!'
            });
        }

        // Verificar compras ativas
        const activePurchases = await prisma.purchase.findMany({
            where: {
                user_id: userId,
                status: 'active',
                expiry_date: {
                    gt: new Date()
                }
            }
        });

        if (activePurchases.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Você não tem compras ativas para gerar rendimentos.'
            });
        }

        // Calcular total de rendimentos
        const totalIncome = activePurchases.reduce((sum, purchase) => {
            return sum + (purchase.daily_return || 0);
        }, 0);

        if (totalIncome <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Nenhum rendimento disponível para coleta.'
            });
        }

        // Processar transação
        const result = await prisma.$transaction(async (tx) => {
            // 1. Adicionar saldo ao usuário
            const updatedUser = await tx.user.update({
                where: { id: userId },
                data: {
                    saldo: {
                        increment: totalIncome
                    }
                },
                select: {
                    saldo: true,
                    mobile: true
                }
            });

            // 2. Registrar tarefa concluída
            const task = await tx.dailyTask.create({
                data: {
                    user_id: userId,
                    task_date: new Date(),
                    task_type: 'product_income',
                    amount: totalIncome,
                    description: `Rendimentos coletados de ${activePurchases.length} produto(s) ativo(s)`,
                    status: 'completed'
                }
            });

            // 3. Atualizar status do usuário
            await tx.userTaskStatus.upsert({
                where: { user_id: userId },
                update: {
                    product_income_completed: true,
                    updated_at: new Date()
                },
                create: {
                    user_id: userId,
                    daily_checkin_completed: false,
                    product_income_completed: true,
                    last_task_date: new Date()
                }
            });

            // 4. Registrar transação
            await tx.transaction.create({
                data: {
                    user_id: userId,
                    type: 'product_income',
                    amount: totalIncome,
                    description: `Rendimentos diários de ${activePurchases.length} produto(s)`,
                    balance_after: updatedUser.saldo,
                    created_at: new Date()
                }
            });

            // 5. Atualizar último payout das compras
            for (const purchase of activePurchases) {
                await tx.purchase.update({
                    where: { id: purchase.id },
                    data: {
                        last_payout: new Date(),
                        total_earned: {
                            increment: purchase.daily_return || 0
                        },
                        payout_count: {
                            increment: 1
                        }
                    }
                });
            }

            // 6. Registrar log
            await tx.systemLog.create({
                data: {
                    action: 'PRODUCT_INCOME_COLLECTION',
                    description: `Usuário ${updatedUser.mobile} coletou ${totalIncome} KZ de ${activePurchases.length} produto(s)`,
                    user_id: userId,
                    created_at: new Date()
                }
            });

            return {
                new_balance: updatedUser.saldo,
                task: task,
                total_income: totalIncome,
                products_count: activePurchases.length
            };
        });

        res.json({
            success: true,
            message: `Rendimentos coletados com sucesso! +${totalIncome} KZ adicionados.`,
            data: {
                new_balance: result.new_balance,
                total_income: totalIncome,
                products_count: result.products_count,
                products: activePurchases.map(p => ({
                    id: p.id,
                    name: p.product_name,
                    daily_income: p.daily_return
                }))
            }
        });

    } catch (error) {
        console.error('Erro ao coletar rendimentos:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para obter histórico de tarefas
app.get('/api/tasks/history', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { page = 1, limit = 30, task_type } = req.query;
        
        const whereClause = { user_id: userId };
        if (task_type) {
            whereClause.task_type = task_type;
        }
        
        const tasks = await prisma.dailyTask.findMany({
            where: whereClause,
            orderBy: { task_date: 'desc' },
            skip: (parseInt(page) - 1) * parseInt(limit),
            take: parseInt(limit),
            select: {
                id: true,
                task_date: true,
                task_type: true,
                amount: true,
                description: true,
                status: true
            }
        });
        
        const total = await prisma.dailyTask.count({
            where: whereClause
        });
        
        res.json({
            success: true,
            data: {
                tasks,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / parseInt(limit))
                }
            }
        });
        
    } catch (error) {
        console.error('Erro ao buscar histórico de tarefas:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para obter dados da equipe (estatísticas)
app.get('/api/team/statistics', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        // Buscar rede de referência
        const referralNetwork = await prisma.referralLevel.findMany({
            where: { referrer_id: userId },
            include: {
                user: {
                    select: {
                        id: true,
                        mobile: true,
                        saldo: true,
                        created_at: true
                    }
                }
            }
        });

        // Organizar por níveis
        const organizedReferrals = {
            level1: referralNetwork.filter(item => item.level === 1).map(item => item.user),
            level2: referralNetwork.filter(item => item.level === 2).map(item => item.user),
            level3: referralNetwork.filter(item => item.level === 3).map(item => item.user)
        };

        // Contagens por nível
        const referralCounts = {
            level1: organizedReferrals.level1.length,
            level2: organizedReferrals.level2.length,
            level3: organizedReferrals.level3.length,
            total: organizedReferrals.level1.length + organizedReferrals.level2.length + organizedReferrals.level3.length
        };

        // Buscar bônus recebidos
        const receivedBonuses = await prisma.referralBonus.findMany({
            where: { referrer_id: userId },
            select: {
                bonus_amount: true,
                level: true,
                created_at: true,
                referred_user: {
                    select: {
                        mobile: true
                    }
                }
            },
            orderBy: { created_at: 'desc' }
        });

        // Calcular totais de bônus
        const bonusTotals = {
            level1: receivedBonuses.filter(b => b.level === 1).reduce((sum, b) => sum + b.bonus_amount, 0),
            level2: receivedBonuses.filter(b => b.level === 2).reduce((sum, b) => sum + b.bonus_amount, 0),
            level3: receivedBonuses.filter(b => b.level === 3).reduce((sum, b) => sum + b.bonus_amount, 0),
            total: receivedBonuses.reduce((sum, b) => sum + b.bonus_amount, 0)
        };

        // Buscar recargas da equipe (compras dos referidos)
        const teamPurchases = await prisma.purchase.findMany({
            where: {
                user_id: {
                    in: referralNetwork.map(r => r.user_id)
                }
            },
            select: {
                user_id: true,
                amount: true,
                purchase_date: true,
                user: {
                    select: {
                        mobile: true
                    }
                }
            }
        });

        // Calcular recargas da equipe
        const teamRecharge = {
            total: teamPurchases.reduce((sum, p) => sum + p.amount, 0),
            level1: teamPurchases.filter(p => 
                organizedReferrals.level1.some(r => r.id === p.user_id)
            ).reduce((sum, p) => sum + p.amount, 0),
            level2: teamPurchases.filter(p => 
                organizedReferrals.level2.some(r => r.id === p.user_id)
            ).reduce((sum, p) => sum + p.amount, 0),
            level3: teamPurchases.filter(p => 
                organizedReferrals.level3.some(r => r.id === p.user_id)
            ).reduce((sum, p) => sum + p.amount, 0)
        };

        // Buscar código de convite do usuário
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                invitation_code: true,
                mobile: true
            }
        });

        const responseData = {
            team_overview: {
                invitation_link: `https://microsoftt.pages.dev/register?ref=${user.invitation_code}`,
                people_added: referralCounts.total,
                income_added: bonusTotals.total
            },
            income_analysis: {
                team_size: referralCounts.total,
                cumulative_recharge: teamRecharge.total,
                processing_recharge: 0, // Pode ser implementado se houver status de processamento
                valid_withdrawal: bonusTotals.total // Bônus disponíveis para saque
            },
            level_data: {
                level1: {
                    valid_members: referralCounts.level1,
                    team_recharge: teamRecharge.level1,
                    team_withdrawal: bonusTotals.level1,
                    commission_percentage: 25
                },
                level2: {
                    valid_members: referralCounts.level2,
                    team_recharge: teamRecharge.level2,
                    team_withdrawal: bonusTotals.level2,
                    commission_percentage: 2
                },
                level3: {
                    valid_members: referralCounts.level3,
                    team_recharge: teamRecharge.level3,
                    team_withdrawal: bonusTotals.level3,
                    commission_percentage: 1
                }
            },
            recent_bonuses: receivedBonuses.slice(0, 10) // Últimos 10 bônus
        };

        res.json({
            success: true,
            data: responseData
        });

    } catch (error) {
        console.error('Erro ao buscar estatísticas da equipe:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para listar comissões detalhadas
app.get('/api/team/commissions', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { page = 1, limit = 20, level } = req.query;

        const whereClause = { referrer_id: userId };
        if (level) {
            whereClause.level = parseInt(level);
        }

        const commissions = await prisma.referralBonus.findMany({
            where: whereClause,
            include: {
                referred_user: {
                    select: {
                        mobile: true,
                        invitation_code: true
                    }
                }
            },
            orderBy: { created_at: 'desc' },
            skip: (parseInt(page) - 1) * parseInt(limit),
            take: parseInt(limit)
        });

        const total = await prisma.referralBonus.count({
            where: whereClause
        });

        // Calcular totais por nível
        const levelTotals = {
            level1: await prisma.referralBonus.aggregate({
                where: { ...whereClause, level: 1 },
                _sum: { bonus_amount: true }
            }),
            level2: await prisma.referralBonus.aggregate({
                where: { ...whereClause, level: 2 },
                _sum: { bonus_amount: true }
            }),
            level3: await prisma.referralBonus.aggregate({
                where: { ...whereClause, level: 3 },
                _sum: { bonus_amount: true }
            })
        };

        res.json({
            success: true,
            data: {
                commissions,
                totals: {
                    level1: levelTotals.level1._sum.bonus_amount || 0,
                    level2: levelTotals.level2._sum.bonus_amount || 0,
                    level3: levelTotals.level3._sum.bonus_amount || 0,
                    overall: levelTotals.level1._sum.bonus_amount + 
                            levelTotals.level2._sum.bonus_amount + 
                            levelTotals.level3._sum.bonus_amount
                },
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / parseInt(limit))
                }
            }
        });

    } catch (error) {
        console.error('Erro ao buscar comissões:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para listar membros da equipe
app.get('/api/team/members', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { level, page = 1, limit = 50 } = req.query;

        const whereClause = { referrer_id: userId };
        if (level) {
            whereClause.level = parseInt(level);
        }

        const members = await prisma.referralLevel.findMany({
            where: whereClause,
            include: {
                user: {
                    select: {
                        id: true,
                        mobile: true,
                        saldo: true,
                        created_at: true,
                        invitation_code: true
                    }
                }
            },
            orderBy: { created_at: 'desc' },
            skip: (parseInt(page) - 1) * parseInt(limit),
            take: parseInt(limit)
        });

        const total = await prisma.referralLevel.count({
            where: whereClause
        });

        // Calcular estatísticas dos membros
        const memberStats = await Promise.all(
            members.map(async (member) => {
                const purchases = await prisma.purchase.count({
                    where: { user_id: member.user_id }
                });

                const totalSpent = await prisma.purchase.aggregate({
                    where: { user_id: member.user_id },
                    _sum: { amount: true }
                });

                return {
                    ...member,
                    purchase_count: purchases,
                    total_spent: totalSpent._sum.amount || 0
                };
            })
        );

        res.json({
            success: true,
            data: {
                members: memberStats,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / parseInt(limit))
                }
            }
        });

    } catch (error) {
        console.error('Erro ao buscar membros da equipe:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// PROCESSAMENTO AUTOMÁTICO PARA PRODUÇÃO
async function processAutomaticPayouts() {
    try {
        console.log(`${new Date().toISOString()} - Executando processamento automático de rendimentos`);
        
        const response = await fetch(`http://localhost:${PORT}/api/process-payouts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + jwt.sign({ system: true }, JWT_SECRET)
            }
        });
        
        if (response.ok) {
            const result = await response.json();
            console.log(`${new Date().toISOString()} - Rendimentos processados: ${result.data.processed}`);
        } else {
            console.error('Erro na requisição de processamento:', response.status);
        }
    } catch (error) {
        console.error('Erro ao processar rendimentos automáticos:', error);
    }
}

// Rota para listar membros da equipe com mais detalhes
app.get('/api/team/members-detailed', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { page = 1, limit = 50, level } = req.query;

        const whereClause = { referrer_id: userId };
        if (level) {
            whereClause.level = parseInt(level);
        }

        const members = await prisma.referralLevel.findMany({
            where: whereClause,
            include: {
                user: {
                    select: {
                        id: true,
                        mobile: true,
                        saldo: true,
                        created_at: true,
                        invitation_code: true,
                        // assumindo que há um campo status
                    }
                }
            },
            orderBy: { created_at: 'desc' },
            skip: (parseInt(page) - 1) * parseInt(limit),
            take: parseInt(limit)
        });

        // Buscar bônus para cada membro
        const membersWithDetails = await Promise.all(
            members.map(async (member) => {
                // Total de recargas do membro
                const purchases = await prisma.purchase.aggregate({
                    where: { user_id: member.user_id },
                    _sum: { amount: true },
                    _count: true
                });

                // Bônus gerados por este membro específico
                const bonusesFromMember = await prisma.referralBonus.aggregate({
                    where: { 
                        referrer_id: userId,
                        referred_user_id: member.user_id
                    },
                    _sum: { bonus_amount: true }
                });

                return {
                    id: member.user.id,
                    mobile: member.user.mobile,
                    level: member.level,
                    registration_date: member.user.created_at,
                    
                    total_recharge: purchases._sum.amount || 0,
                    recharge_count: purchases._count || 0,
                    current_balance: member.user.saldo || 0,
                    generated_bonus: bonusesFromMember._sum.bonus_amount || 0,
                    // Calcular valor do bônus decodificado em porcentagem
                    bonus_value: calculateBonusValue(purchases._sum.amount || 0, member.level)
                };
            })
        );

        const total = await prisma.referralLevel.count({
            where: whereClause
        });

        res.json({
            success: true,
            data: {
                members: membersWithDetails,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / parseInt(limit))
                }
            }
        });

    } catch (error) {
        console.error('Erro ao buscar membros detalhados da equipe:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Função para calcular o valor do bônus baseado na porcentagem
function calculateBonusValue(rechargeAmount, level) {
    const commissionRates = {
        1: 0.25, // ✅ 25%
        2: 0.02, // ✅ 2%
        3: 0.01  // ✅ 1% (CORRIGIDO)
    };
    
    return rechargeAmount * (commissionRates[level] || 0);
}

// Rota para solicitar saque
app.post('/api/withdraw', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { amount, tax, net_amount, account_name, iban, bank_name, bank_code } = req.body;
        
        // Validar dados
        if (!amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Valor de saque inválido'
            });
        }
        
        if (!account_name || !iban || !bank_name) {
            return res.status(400).json({
                success: false,
                message: 'Informações bancárias incompletas'
            });
        }
        
        // Verificar saldo do usuário
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { saldo: true, mobile: true }
        });
        
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }
        
        if (user.saldo < amount) {
            return res.status(400).json({
                success: false,
                message: 'Saldo insuficiente'
            });
        }
        
        // Processar transação
        const result = await prisma.$transaction(async (tx) => {
            // 1. Deduzir saldo do usuário
            const updatedUser = await tx.user.update({
                where: { id: userId },
                data: {
                    saldo: {
                        decrement: amount
                    }
                },
                select: {
                    saldo: true
                }
            });
            
            // 2. Registrar saque
            const withdrawal = await tx.withdrawal.create({
                data: {
                    user_id: userId,
                    amount: amount,
                    tax: tax,
                    net_amount: net_amount,
                    account_name: account_name,
                    iban: iban,
                    bank_name: bank_name,
                    bank_code: bank_code,
                    status: 'pending',
                    created_at: new Date()
                }
            });
            
            // 3. Registrar transação
            await tx.transaction.create({
                data: {
                    user_id: userId,
                    type: 'withdrawal',
                    amount: -amount,
                    description: `Saque bancário - ${bank_name}`,
                    balance_after: updatedUser.saldo,
                    created_at: new Date()
                }
            });
            
            // 4. Registrar log
            await tx.systemLog.create({
                data: {
                    action: 'WITHDRAWAL_REQUEST',
                    description: `Usuário ${user.mobile} solicitou saque de ${amount} KZ`,
                    user_id: userId,
                    created_at: new Date()
                }
            });
            
            return {
                withdrawal: withdrawal,
                new_balance: updatedUser.saldo
            };
        });
        
        res.json({
            success: true,
            message: 'Saque solicitado com sucesso',
            data: {
                withdrawal_id: result.withdrawal.id,
                new_balance: result.new_balance
            }
        });
        
    } catch (error) {
        console.error('Erro ao processar saque:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para obter histórico de saques
app.get('/api/withdrawals', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { page = 1, limit = 20 } = req.query;
        
        const withdrawals = await prisma.withdrawal.findMany({
            where: { user_id: userId },
            orderBy: { created_at: 'desc' },
            skip: (parseInt(page) - 1) * parseInt(limit),
            take: parseInt(limit),
            select: {
                id: true,
                amount: true,
                tax: true,
                net_amount: true,
                account_name: true,
                iban: true,
                bank_name: true,
                bank_code: true,
                status: true,
                created_at: true,
                processed_at: true
            }
        });
        
        const total = await prisma.withdrawal.count({
            where: { user_id: userId }
        });
        
        res.json({
            success: true,
            data: {
                withdrawals,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / parseInt(limit))
                }
            }
        });
        
    } catch (error) {
        console.error('Erro ao buscar histórico de saques:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Adicione estas rotas ao seu server.js, antes do app.listen()

// Rota para solicitar depósito
app.post('/api/deposit', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { amount, account_name, iban, bank_name, bank_code } = req.body;
        
        // Validar dados
        if (!amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Valor de depósito inválido'
            });
        }
        
        if (!account_name || !iban || !bank_name) {
            return res.status(400).json({
                success: false,
                message: 'Informações bancárias incompletas'
            });
        }

        // Validar valor mínimo
        if (amount < 1000) {
            return res.status(400).json({
                success: false,
                message: 'Valor mínimo de depósito é 1.000 KZ'
            });
        }
        
        // Criar solicitação de depósito
        const deposit = await prisma.deposit.create({
            data: {
                user_id: userId,
                amount: amount,
                account_name: account_name,
                iban: iban,
                bank_name: bank_name,
                bank_code: bank_code,
                status: 'pending',
                created_at: new Date()
            }
        });
        
        // Registrar log
        await prisma.systemLog.create({
            data: {
                action: 'DEPOSIT_REQUEST',
                description: `Usuário solicitou depósito de ${amount} KZ`,
                user_id: userId,
                created_at: new Date()
            }
        });
        
        res.json({
            success: true,
            message: 'Solicitação de depósito criada com sucesso',
            data: {
                deposit_id: deposit.id,
                amount: amount,
                account_name: account_name,
                bank_name: bank_name,
                status: 'pending'
            }
        });
        
    } catch (error) {
        console.error('Erro ao processar depósito:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para upload do comprovante de depósito
app.post('/api/deposit/:id/receipt', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { receipt_image } = req.body;
        
        if (!receipt_image) {
            return res.status(400).json({
                success: false,
                message: 'Imagem do comprovante é obrigatória'
            });
        }
        
        // Verificar se o depósito existe e pertence ao usuário
        const deposit = await prisma.deposit.findFirst({
            where: {
                id: id,
                user_id: req.user.id
            }
        });
        
        if (!deposit) {
            return res.status(404).json({
                success: false,
                message: 'Depósito não encontrado'
            });
        }
        
        // Atualizar depósito com a imagem do comprovante
        const updatedDeposit = await prisma.deposit.update({
            where: { id: id },
            data: {
                receipt_image: receipt_image,
                updated_at: new Date()
            }
        });
        
        res.json({
            success: true,
            message: 'Comprovante enviado com sucesso',
            data: updatedDeposit
        });
        
    } catch (error) {
        console.error('Erro ao enviar comprovante:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para obter histórico de depósitos
app.get('/api/deposits', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { page = 1, limit = 20 } = req.query;
        
        const deposits = await prisma.deposit.findMany({
            where: { user_id: userId },
            orderBy: { created_at: 'desc' },
            skip: (parseInt(page) - 1) * parseInt(limit),
            take: parseInt(limit),
            select: {
                id: true,
                amount: true,
                account_name: true,
                iban: true,
                bank_name: true,
                bank_code: true,
                status: true,
                receipt_image: true,
                created_at: true,
                updated_at: true,
                processed_at: true
            }
        });
        
        const total = await prisma.deposit.count({
            where: { user_id: userId }
        });
        
        res.json({
            success: true,
            data: {
                deposits,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / parseInt(limit))
                }
            }
        });
        
    } catch (error) {
        console.error('Erro ao buscar histórico de depósitos:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para admin aprovar depósito
app.put('/api/admin/deposit/:id/approve', authenticateToken, async (req, res) => {
    try {
        // Verificar se é admin (implemente sua lógica de admin)
        // if (!req.user.isAdmin) { ... }
        
        const { id } = req.params;
        
        const deposit = await prisma.deposit.findUnique({
            where: { id: id },
            include: { user: true }
        });
        
        if (!deposit) {
            return res.status(404).json({
                success: false,
                message: 'Depósito não encontrado'
            });
        }
        
        if (deposit.status === 'completed') {
            return res.status(400).json({
                success: false,
                message: 'Depósito já foi processado'
            });
        }
        
        // Processar transação de aprovação
        const result = await prisma.$transaction(async (tx) => {
            // 1. Buscar saldo atual
            const currentUser = await tx.user.findUnique({
                where: { id: deposit.user_id },
                select: { saldo: true }
            });
            
            // 2. Adicionar saldo ao usuário
            const updatedUser = await tx.user.update({
                where: { id: deposit.user_id },
                data: {
                    saldo: {
                        increment: deposit.amount
                    }
                },
                select: {
                    saldo: true
                }
            });
            
            // 3. Atualizar status do depósito
            const updatedDeposit = await tx.deposit.update({
                where: { id: id },
                data: {
                    status: 'completed',
                    processed_at: new Date()
                }
            });
            
            // 4. Registrar transação
            await tx.transaction.create({
                data: {
                    user_id: deposit.user_id,
                    type: 'deposit',
                    amount: deposit.amount,
                    description: `Depósito aprovado - ${deposit.bank_name}`,
                    balance_after: updatedUser.saldo,
                    created_at: new Date()
                }
            });
            
            return {
                deposit: updatedDeposit,
                new_balance: updatedUser.saldo,
                previous_balance: currentUser.saldo
            };
        });
        
        res.json({
            success: true,
            message: 'Depósito aprovado com sucesso',
            data: result
        });
        
    } catch (error) {
        console.error('Erro ao aprovar depósito:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para rejeitar depósito
app.put('/api/admin/deposit/:id/reject', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        
        const deposit = await prisma.deposit.findUnique({
            where: { id: id }
        });
        
        if (!deposit) {
            return res.status(404).json({
                success: false,
                message: 'Depósito não encontrado'
            });
        }
        
        const updatedDeposit = await prisma.deposit.update({
            where: { id: id },
            data: {
                status: 'failed',
                processed_at: new Date()
            }
        });
        
        await prisma.systemLog.create({
            data: {
                action: 'DEPOSIT_REJECTED',
                description: `Depósito ${id} rejeitado. Motivo: ${reason || 'Não especificado'}`,
                user_id: deposit.user_id,
                created_at: new Date()
            }
        });
        
        res.json({
            success: true,
            message: 'Depósito rejeitado com sucesso',
            data: updatedDeposit
        });
        
    } catch (error) {
        console.error('Erro ao rejeitar depósito:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// ==============================================
// CHAT APIs
// ==============================================

// Enviar mensagem no chat
app.post('/api/chat/send', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { message } = req.body;
        const images = req.files || [];

        if (!message && images.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Mensagem ou imagem é obrigatória'
            });
        }

        // Upload de imagens (se houver)
        let imageUrl = null;
        if (images.length > 0) {
            // Implementar upload para Cloudinary/AWS/S3
            imageUrl = await uploadImage(images[0]);
        }

        const chatMessage = await prisma.chatMessage.create({
            data: {
                user_id: userId,
                message: message,
                image_url: imageUrl,
                message_type: imageUrl ? 'IMAGE' : 'TEXT',
                is_from_user: true,
                is_read: false
            },
            include: {
                user: {
                    select: {
                        mobile: true
                    }
                }
            }
        });

        // WebSocket - notificar admin sobre nova mensagem
        notifyAdmins('new_message', {
            message: chatMessage,
            user_mobile: chatMessage.user.mobile
        });

        res.json({
            success: true,
            message: 'Mensagem enviada com sucesso',
            data: { message: chatMessage }
        });

    } catch (error) {
        console.error('Erro ao enviar mensagem:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Obter mensagens do chat
app.get('/api/chat/messages', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { page = 1, limit = 50 } = req.query;

        const messages = await prisma.chatMessage.findMany({
            where: { user_id: userId },
            orderBy: { created_at: 'asc' },
            skip: (parseInt(page) - 1) * parseInt(limit),
            take: parseInt(limit),
            include: {
                user: {
                    select: {
                        mobile: true
                    }
                }
            }
        });

        // Marcar mensagens do admin como lidas
        await prisma.chatMessage.updateMany({
            where: {
                user_id: userId,
                is_from_user: false,
                is_read: false
            },
            data: {
                is_read: true
            }
        });

        res.json({
            success: true,
            data: {
                messages,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total: await prisma.chatMessage.count({ where: { user_id: userId } })
                }
            }
        });

    } catch (error) {
        console.error('Erro ao buscar mensagens:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// ==============================================
// POSTS APIs
// ==============================================

// Criar publicação
app.post('/api/posts/create', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { content } = req.body;
        const images = req.files || [];

        if (!content && images.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Conteúdo ou imagem é obrigatório'
            });
        }

        if (images.length > 3) {
            return res.status(400).json({
                success: false,
                message: 'Máximo de 3 imagens permitido'
            });
        }

        // Upload das imagens
        const imageUrls = [];
        for (const image of images) {
            const url = await uploadImage(image);
            imageUrls.push(url);
        }

        const post = await prisma.post.create({
            data: {
                user_id: userId,
                content: content,
                images: imageUrls
            },
            include: {
                user: {
                    select: {
                        mobile: true
                    }
                },
                likes: {
                    where: { user_id: userId },
                    select: { id: true }
                },
                comments: {
                    include: {
                        user: {
                            select: {
                                mobile: true
                            }
                        }
                    },
                    orderBy: { created_at: 'asc' },
                    take: 10
                }
            }
        });

        res.json({
            success: true,
            message: 'Publicação criada com sucesso',
            data: { post: {
                ...post,
                user_has_liked: post.likes.length > 0,
                like_count: 0, // Será atualizado
                comment_count: 0
            }}
        });

    } catch (error) {
        console.error('Erro ao criar post:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Obter publicações
app.get('/api/posts', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { page = 1, limit = 20 } = req.query;

        const posts = await prisma.post.findMany({
            orderBy: { created_at: 'desc' },
            skip: (parseInt(page) - 1) * parseInt(limit),
            take: parseInt(limit),
            include: {
                user: {
                    select: {
                        mobile: true
                    }
                },
                likes: {
                    where: { user_id: userId },
                    select: { id: true }
                },
                _count: {
                    select: {
                        likes: true,
                        comments: true
                    }
                },
                comments: {
                    include: {
                        user: {
                            select: {
                                mobile: true
                            }
                        }
                    },
                    orderBy: { created_at: 'asc' },
                    take: 5
                }
            }
        });

        const formattedPosts = posts.map(post => ({
            ...post,
            user_has_liked: post.likes.length > 0,
            like_count: post._count.likes,
            comment_count: post._count.comments
        }));

        res.json({
            success: true,
            data: {
                posts: formattedPosts,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total: await prisma.post.count()
                }
            }
        });

    } catch (error) {
        console.error('Erro ao buscar posts:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Curtir publicação
app.post('/api/posts/:postId/like', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { postId } = req.params;

        const existingLike = await prisma.like.findUnique({
            where: {
                user_id_post_id: {
                    user_id: userId,
                    post_id: postId
                }
            }
        });

        if (existingLike) {
            // Remover like
            await prisma.like.delete({
                where: {
                    user_id_post_id: {
                        user_id: userId,
                        post_id: postId
                    }
                }
            });
        } else {
            // Adicionar like
            await prisma.like.create({
                data: {
                    user_id: userId,
                    post_id: postId
                }
            });
        }

        const likeCount = await prisma.like.count({
            where: { post_id: postId }
        });

        res.json({
            success: true,
            data: {
                liked: !existingLike,
                like_count: likeCount
            }
        });

    } catch (error) {
        console.error('Erro ao curtir post:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Comentar publicação
app.post('/api/posts/:postId/comment', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { postId } = req.params;
        const { content } = req.body;

        if (!content) {
            return res.status(400).json({
                success: false,
                message: 'Conteúdo do comentário é obrigatório'
            });
        }

        const comment = await prisma.comment.create({
            data: {
                user_id: userId,
                post_id: postId,
                content: content
            },
            include: {
                user: {
                    select: {
                        mobile: true
                    }
                }
            }
        });

        res.json({
            success: true,
            message: 'Comentário adicionado com sucesso',
            data: { comment }
        });

    } catch (error) {
        console.error('Erro ao comentar:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// ==============================================
// ADMIN APIs (Para o painel administrativo)
// ==============================================

// Obter conversas para admin
app.get('/api/admin/chats', authenticateToken, async (req, res) => {
    try {
        // Verificar se é admin
        // if (!req.user.isAdmin) return res.status(403).json(...)

        const chats = await prisma.user.findMany({
            where: {
                chatMessages: {
                    some: {}
                }
            },
            include: {
                chatMessages: {
                    orderBy: { created_at: 'desc' },
                    take: 1
                },
                _count: {
                    select: {
                        chatMessages: {
                            where: {
                                is_from_user: true,
                                is_read: false
                            }
                        }
                    }
                }
            }
        });

        const formattedChats = chats.map(user => ({
            user_id: user.id,
            mobile: user.mobile,
            last_message: user.chatMessages[0],
            unread_count: user._count.chatMessages,
            last_activity: user.chatMessages[0]?.created_at
        }));

        res.json({
            success: true,
            data: { chats: formattedChats }
        });

    } catch (error) {
        console.error('Erro ao buscar chats:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Admin responder mensagem
app.post('/api/admin/chat/:userId/respond', authenticateToken, async (req, res) => {
    try {
        // Verificar se é admin
        const { userId } = req.params;
        const { message } = req.body;
        const images = req.files || [];

        let imageUrl = null;
        if (images.length > 0) {
            imageUrl = await uploadImage(images[0]);
        }

        const chatMessage = await prisma.chatMessage.create({
            data: {
                user_id: userId,
                message: message,
                image_url: imageUrl,
                message_type: imageUrl ? 'IMAGE' : 'TEXT',
                is_from_user: false,
                is_read: false
            }
        });

        // WebSocket - notificar usuário
        notifyUser(userId, 'new_message', { message: chatMessage });

        res.json({
            success: true,
            message: 'Resposta enviada com sucesso',
            data: { message: chatMessage }
        });

    } catch (error) {
        console.error('Erro ao responder:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});



// Função auxiliar para upload de imagens
async function uploadImage(file) {
    // Implementar upload para seu serviço preferido
    // Retornar URL da imagem
    return `https://example.com/images/${Date.now()}-${file.originalname}`;
}

// WebSocket functions (implementação básica)
function notifyAdmins(type, data) {
    // Implementar notificação para admins via WebSocket
}

function notifyUser(userId, type, data) {
    // Implementar notificação para usuário específico
}

// ==============================================
// ADMIN2 ROUTES - NOVAS FUNCIONALIDADES COMPLETAS
// ==============================================



// Rota para eliminar usuário
app.delete('/api/admin2/users/:id/delete', requireAdmin2, async (req, res) => {
    try {
        const { id } = req.params;

        // Verificar se o usuário existe
        const user = await prisma.user.findUnique({
            where: { id: id },
            include: {
                _count: {
                    select: {
                        purchases: true,
                        transactions: true,
                        withdrawals: true,
                        deposits: true
                    }
                }
            }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        // Eliminar o usuário e todos os dados relacionados
        await prisma.$transaction(async (tx) => {
            // 1. Eliminar dados relacionados
            await tx.dailyTask.deleteMany({ where: { user_id: id } });
            await tx.dailyCheckin.deleteMany({ where: { user_id: id } });
            await tx.referralBonus.deleteMany({ where: { referrer_id: id } });
            await tx.referralBonus.deleteMany({ where: { referred_user_id: id } });
            await tx.referralLevel.deleteMany({ where: { referrer_id: id } });
            await tx.referralLevel.deleteMany({ where: { user_id: id } });
            await tx.transaction.deleteMany({ where: { user_id: id } });
            await tx.withdrawal.deleteMany({ where: { user_id: id } });
            await tx.deposit.deleteMany({ where: { user_id: id } });
            await tx.purchase.deleteMany({ where: { user_id: id } });
            await tx.systemLog.deleteMany({ where: { user_id: id } });
            
            // 2. Atualizar referências de usuários que foram convidados por este usuário
            await tx.user.updateMany({
                where: { inviter_id: id },
                data: { inviter_id: null }
            });

            // 3. Eliminar o usuário
            await tx.user.delete({
                where: { id: id }
            });
        });

        // Registrar log
        await prisma.systemLog.create({
            data: {
                action: 'USER_DELETED_ADMIN2',
                description: `Admin2 eliminou usuário ${user.mobile} e todos os dados relacionados`,
                created_at: new Date()
            }
        });

        res.json({
            success: true,
            message: `Usuário ${user.mobile} eliminado com sucesso! Todos os dados relacionados foram removidos.`
        });

    } catch (error) {
        console.error('Erro ao eliminar usuário:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para redefinir senha do usuário
app.put('/api/admin2/users/:id/reset-password', requireAdmin2, async (req, res) => {
    try {
        const { id } = req.params;
        const { new_password } = req.body;

        if (!new_password) {
            return res.status(400).json({
                success: false,
                message: 'Nova senha é obrigatória'
            });
        }

        // Verificar se o usuário existe
        const user = await prisma.user.findUnique({
            where: { id: id }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        // Criptografar nova senha
        const hashedPassword = await bcrypt.hash(new_password, 10);

        // Atualizar senha
        await prisma.user.update({
            where: { id: id },
            data: {
                password: hashedPassword,
                updated_at: new Date()
            }
        });

        // Registrar log
        await prisma.systemLog.create({
            data: {
                action: 'PASSWORD_RESET_ADMIN2',
                description: `Admin2 redefiniu senha do usuário ${user.mobile}`,
                user_id: id,
                created_at: new Date()
            }
        });

        res.json({
            success: true,
            message: 'Senha redefinida com sucesso!'
        });

    } catch (error) {
        console.error('Erro ao redefinir senha:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para anular/eliminar compra
app.delete('/api/admin2/purchases/:id/cancel', requireAdmin2, async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        // Buscar a compra
        const purchase = await prisma.purchase.findUnique({
            where: { id: id },
            include: {
                user: {
                    select: {
                        id: true,
                        mobile: true,
                        saldo: true
                    }
                }
            }
        });

        if (!purchase) {
            return res.status(404).json({
                success: false,
                message: 'Compra não encontrada'
            });
        }

        if (purchase.status === 'cancelled') {
            return res.status(400).json({
                success: false,
                message: 'Compra já está cancelada'
            });
        }

        // Processar cancelamento com reembolso
        await prisma.$transaction(async (tx) => {
            // 1. Reembolsar saldo ao usuário (se a compra estava ativa)
            if (purchase.status === 'active') {
                const updatedUser = await tx.user.update({
                    where: { id: purchase.user_id },
                    data: {
                        saldo: {
                            increment: purchase.amount
                        }
                    },
                    select: {
                        saldo: true
                    }
                });

                // 2. Registrar transação de reembolso
                await tx.transaction.create({
                    data: {
                        user_id: purchase.user_id,
                        type: 'purchase_refund',
                        amount: purchase.amount,
                        description: `Reembolso de compra cancelada: ${purchase.product_name}`,
                        balance_after: updatedUser.saldo,
                        created_at: new Date()
                    }
                });
            }

            // 3. Marcar compra como cancelada
            await tx.purchase.update({
                where: { id: id },
                data: {
                    status: 'cancelled',
                    expiry_date: new Date() // Define como expirada
                }
            });

            // 4. Registrar log
            await tx.systemLog.create({
                data: {
                    action: 'PURCHASE_CANCELLED_ADMIN2',
                    description: `Admin2 cancelou compra ${id}. Produto: ${purchase.product_name}, Valor: ${purchase.amount} KZ. Motivo: ${reason || 'Não especificado'}`,
                    user_id: purchase.user_id,
                    created_at: new Date()
                }
            });
        });

        res.json({
            success: true,
            message: 'Compra cancelada com sucesso! Valor reembolsado ao usuário.'
        });

    } catch (error) {
        console.error('Erro ao cancelar compra:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para adicionar produto manualmente (dar produto)
app.post('/api/admin2/users/:id/add-product', requireAdmin2, async (req, res) => {
    try {
        const { id } = req.params;
        const { product_name, amount, daily_return, cycle_days, quantity } = req.body;

        if (!product_name || !amount) {
            return res.status(400).json({
                success: false,
                message: 'Nome do produto e valor são obrigatórios'
            });
        }

        // Verificar se o usuário existe
        const user = await prisma.user.findUnique({
            where: { id: id },
            select: { id: true, mobile: true, saldo: true }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        // Calcular datas
        const nextPayout = new Date();
        nextPayout.setHours(nextPayout.getHours() + 24);

        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + (cycle_days || 30));

        // Criar produto manualmente
        const purchase = await prisma.purchase.create({
            data: {
                user_id: id,
                product_id: 'admin_gift_' + Date.now(),
                product_name: product_name,
                amount: amount,
                quantity: quantity || 1,
                daily_return: daily_return || 13,
                cycle_days: cycle_days || 30,
                purchase_date: new Date(),
                next_payout: nextPayout,
                expiry_date: expiryDate,
                status: 'active',
                total_earned: 0,
                payout_count: 0
            }
        });

        // Registrar log
        await prisma.systemLog.create({
            data: {
                action: 'PRODUCT_ADDED_ADMIN2',
                description: `Admin2 adicionou produto manualmente para ${user.mobile}. Produto: ${product_name}, Valor: ${amount} KZ`,
                user_id: id,
                created_at: new Date()
            }
        });

        res.json({
            success: true,
            message: 'Produto adicionado com sucesso!',
            data: { purchase }
        });

    } catch (error) {
        console.error('Erro ao adicionar produto:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para editar informações do usuário
app.put('/api/admin2/users/:id/edit', requireAdmin2, async (req, res) => {
    try {
        const { id } = req.params;
        const { mobile, nickname, sex, head_img } = req.body;

        // Verificar se o usuário existe
        const user = await prisma.user.findUnique({
            where: { id: id }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        // Atualizar dados
        const updateData = { updated_at: new Date() };
        if (mobile) updateData.mobile = mobile;
        if (nickname !== undefined) updateData.nickname = nickname;
        if (sex !== undefined) updateData.sex = sex;
        if (head_img !== undefined) updateData.head_img = head_img;

        const updatedUser = await prisma.user.update({
            where: { id: id },
            data: updateData,
            select: {
                id: true,
                mobile: true,
                nickname: true,
                sex: true,
                head_img: true,
                saldo: true,
                invitation_code: true,
                updated_at: true
            }
        });

        // Registrar log
        await prisma.systemLog.create({
            data: {
                action: 'USER_EDITED_ADMIN2',
                description: `Admin2 editou informações do usuário ${user.mobile}`,
                user_id: id,
                created_at: new Date()
            }
        });

        res.json({
            success: true,
            message: 'Informações do usuário atualizadas com sucesso!',
            data: { user: updatedUser }
        });

    } catch (error) {
        console.error('Erro ao editar usuário:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para simular ações do usuário (realizar tarefas em nome do usuário)
app.post('/api/admin2/users/:id/simulate-action', requireAdmin2, async (req, res) => {
    try {
        const { id } = req.params;
        const { action_type, amount, description } = req.body;

        if (!action_type) {
            return res.status(400).json({
                success: false,
                message: 'Tipo de ação é obrigatório'
            });
        }

        // Verificar se o usuário existe
        const user = await prisma.user.findUnique({
            where: { id: id },
            select: { id: true, mobile: true, saldo: true }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        let result;

        switch (action_type) {
            case 'daily_checkin':
                result = await simulateDailyCheckin(id, user);
                break;
            case 'collect_income':
                result = await simulateCollectIncome(id, user);
                break;
            case 'add_balance':
                result = await simulateAddBalance(id, user, amount, description);
                break;
            default:
                return res.status(400).json({
                    success: false,
                    message: 'Tipo de ação não suportado'
                });
        }

        res.json({
            success: true,
            message: result.message,
            data: result.data
        });

    } catch (error) {
        console.error('Erro ao simular ação:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Funções auxiliares para simular ações
async function simulateDailyCheckin(userId, user) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Verificar se já fez check-in hoje
    const existingCheckin = await prisma.dailyCheckin.findFirst({
        where: {
            user_id: userId,
            checkin_date: {
                gte: today,
                lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
            }
        }
    });

    if (existingCheckin) {
        throw new Error('Usuário já fez check-in hoje');
    }

    const rewardAmount = 5;
    const nextCheckin = new Date(today);
    nextCheckin.setDate(nextCheckin.getDate() + 1);

    await prisma.$transaction(async (tx) => {
        // Adicionar saldo
        const updatedUser = await tx.user.update({
            where: { id: userId },
            data: {
                saldo: {
                    increment: rewardAmount
                }
            },
            select: {
                saldo: true
            }
        });

        // Registrar check-in
        await tx.dailyCheckin.create({
            data: {
                user_id: userId,
                checkin_date: new Date(),
                amount_received: rewardAmount,
                next_checkin: nextCheckin
            }
        });

        // Registrar transação
        await tx.transaction.create({
            data: {
                user_id: userId,
                type: 'daily_checkin',
                amount: rewardAmount,
                description: 'Check-in diário (simulado pelo admin)',
                balance_after: updatedUser.saldo,
                created_at: new Date()
            }
        });

        // Registrar log
        await tx.systemLog.create({
            data: {
                action: 'CHECKIN_SIMULATED_ADMIN2',
                description: `Admin2 simulou check-in para ${user.mobile}. +${rewardAmount} KZ`,
                user_id: userId,
                created_at: new Date()
            }
        });
    });

    return {
        message: 'Check-in simulado com sucesso! +5 KZ adicionados.',
        data: {
            reward: rewardAmount,
            next_checkin: nextCheckin
        }
    };
}

async function simulateCollectIncome(userId, user) {
    const activePurchases = await prisma.purchase.findMany({
        where: {
            user_id: userId,
            status: 'active',
            expiry_date: {
                gt: new Date()
            }
        }
    });

    if (activePurchases.length === 0) {
        throw new Error('Usuário não tem compras ativas');
    }

    const totalIncome = activePurchases.reduce((sum, purchase) => {
        return sum + (purchase.daily_return || 0);
    }, 0);

    await prisma.$transaction(async (tx) => {
        // Adicionar saldo
        const updatedUser = await tx.user.update({
            where: { id: userId },
            data: {
                saldo: {
                    increment: totalIncome
                }
            },
            select: {
                saldo: true
            }
        });

        // Atualizar compras
        for (const purchase of activePurchases) {
            await tx.purchase.update({
                where: { id: purchase.id },
                data: {
                    last_payout: new Date(),
                    total_earned: {
                        increment: purchase.daily_return || 0
                    },
                    payout_count: {
                        increment: 1
                    }
                }
            });
        }

        // Registrar transação
        await tx.transaction.create({
            data: {
                user_id: userId,
                type: 'product_income',
                amount: totalIncome,
                description: `Rendimentos coletados (simulado pelo admin) de ${activePurchases.length} produto(s)`,
                balance_after: updatedUser.saldo,
                created_at: new Date()
            }
        });

        // Registrar log
        await tx.systemLog.create({
            data: {
                action: 'INCOME_COLLECTED_SIMULATED_ADMIN2',
                description: `Admin2 coletou rendimentos para ${user.mobile}. +${totalIncome} KZ de ${activePurchases.length} produto(s)`,
                user_id: userId,
                created_at: new Date()
            }
        });
    });

    return {
        message: `Rendimentos coletados com sucesso! +${totalIncome} KZ adicionados.`,
        data: {
            total_income: totalIncome,
            products_count: activePurchases.length
        }
    };
}

async function simulateAddBalance(userId, user, amount, description) {
    if (!amount || amount <= 0) {
        throw new Error('Valor deve ser maior que zero');
    }

    await prisma.$transaction(async (tx) => {
        // Adicionar saldo
        const updatedUser = await tx.user.update({
            where: { id: userId },
            data: {
                saldo: {
                    increment: amount
                }
            },
            select: {
                saldo: true
            }
        });

        // Registrar transação
        await tx.transaction.create({
            data: {
                user_id: userId,
                type: 'admin_addition',
                amount: amount,
                description: description || 'Adição de saldo simulada pelo admin',
                balance_after: updatedUser.saldo,
                created_at: new Date()
            }
        });

        // Registrar log
        await tx.systemLog.create({
            data: {
                action: 'BALANCE_ADDED_SIMULATED_ADMIN2',
                description: `Admin2 adicionou saldo para ${user.mobile}. +${amount} KZ. Motivo: ${description || 'Não especificado'}`,
                user_id: userId,
                created_at: new Date()
            }
        });
    });

    return {
        message: `Saldo adicionado com sucesso! +${amount} KZ`,
        data: {
            amount_added: amount
        }
    };
}
// ==============================================
// ROTA /iban - Gerenciar conta bancária do usuário
// ==============================================

// Buscar conta bancária do usuário
app.get('/iban', authenticateToken, async (req, res) => {
  try {
    const account = await prisma.bankAccount.findUnique({
      where: { user_id: req.user.id }
    });

    if (!account) {
      return res.json({
        success: false,
        message: 'Nenhuma conta cadastrada.'
      });
    }

    res.json({
      success: true,
      account
    });
  } catch (error) {
    console.error('Erro ao buscar conta bancária:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno ao buscar conta bancária.'
    });
  }
});

// Criar ou atualizar conta bancária
app.post('/iban', authenticateToken, async (req, res) => {
  try {
    const { bank, account_number, account_holder } = req.body;

    if (!bank || !account_number || !account_holder) {
      return res.status(400).json({
        success: false,
        message: 'Preencha todos os campos obrigatórios.'
      });
    }

    const existingAccount = await prisma.bankAccount.findUnique({
      where: { user_id: req.user.id }
    });

    let account;
    if (existingAccount) {
      // Atualiza dados existentes
      account = await prisma.bankAccount.update({
        where: { user_id: req.user.id },
        data: { bank, account_number, account_holder }
      });
    } else {
      // Cria nova conta
      account = await prisma.bankAccount.create({
        data: {
          user_id: req.user.id,
          bank,
          account_number,
          account_holder
        }
      });
    }

    res.json({
      success: true,
      message: 'Conta bancária salva com sucesso!',
      account
    });
  } catch (error) {
    console.error('Erro ao salvar conta bancária:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno ao salvar conta bancária.'
    });
  }
});
// ==============================================
// ROTAS DE CONTA BANCÁRIA (IBAN)
// ==============================================

// Rota para obter conta bancária do usuário
app.get('/api/user/bank-account', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const bankAccount = await prisma.bankAccount.findUnique({
            where: { user_id: userId },
            select: {
                id: true,
                bank_name: true,
                account_holder: true,
                account_number: true,
                branch_code: true,
                created_at: true,
                updated_at: true
            }
        });

        res.json({
            success: true,
            data: bankAccount || null
        });

    } catch (error) {
        console.error('Erro ao buscar conta bancária:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para criar conta bancária
app.post('/api/user/bank-account', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { bank_name, account_holder, account_number, branch_code } = req.body;
        
        // Validar dados
        if (!bank_name || !account_holder || !account_number || !branch_code) {
            return res.status(400).json({
                success: false,
                message: 'Todos os campos são obrigatórios'
            });
        }

        // Verificar se já existe conta bancária para este usuário
        const existingAccount = await prisma.bankAccount.findUnique({
            where: { user_id: userId }
        });

        if (existingAccount) {
            return res.status(400).json({
                success: false,
                message: 'Você já possui uma conta bancária cadastrada. Use a rota de atualização.'
            });
        }

        // Criar conta bancária
        const bankAccount = await prisma.bankAccount.create({
            data: {
                user_id: userId,
                bank_name: bank_name,
                account_holder: account_holder,
                account_number: account_number,
                branch_code: branch_code,
                created_at: new Date(),
                updated_at: new Date()
            },
            select: {
                id: true,
                bank_name: true,
                account_holder: true,
                account_number: true,
                branch_code: true,
                created_at: true,
                updated_at: true
            }
        });

        // Registrar log
        await prisma.systemLog.create({
            data: {
                action: 'BANK_ACCOUNT_CREATED',
                description: `Usuário cadastrou conta bancária: ${bank_name} - ${account_number}`,
                user_id: userId,
                created_at: new Date()
            }
        });

        res.status(201).json({
            success: true,
            message: 'Conta bancária cadastrada com sucesso!',
            data: bankAccount
        });

    } catch (error) {
        console.error('Erro ao criar conta bancária:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});



// ==============================================
// ENDPOINTS PARA PACOTES/COMPRAS (SEM ALTERAR PRISMA)
// ==============================================

// 1. ROTA PRINCIPAL PARA OBTER PACOTES DO USUÁRIO
app.get('/api/user/purchases', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Buscar todas as compras do usuário
        const purchases = await prisma.purchase.findMany({
            where: {
                user_id: userId
            },
            orderBy: {
                purchase_date: 'desc'
            }
        });

        // Formatar resposta
        const formattedPurchases = purchases.map(purchase => {
            const today = new Date();
            const expiryDate = new Date(purchase.expiry_date);
            const lastPayout = purchase.last_payout ? new Date(purchase.last_payout) : null;
            
            // Calcular dias restantes
            const daysRemaining = Math.max(0, Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24)));
            
            // Verificar se pode coletar hoje
            let canCollect = false;
            if (purchase.status === 'active' && daysRemaining > 0) {
                if (!lastPayout) {
                    canCollect = true; // Nunca coletou
                } else {
                    // Verificar se já coletou hoje
                    const sameDay = lastPayout.getDate() === today.getDate() &&
                                   lastPayout.getMonth() === today.getMonth() &&
                                   lastPayout.getFullYear() === today.getFullYear();
                    canCollect = !sameDay;
                }
            }

            return {
                id: purchase.id,
                product_id: purchase.product_id,
                product_name: purchase.product_name || 'Produto',
                amount: purchase.amount,
                daily_return: purchase.daily_return,
                total_return: purchase.daily_return * purchase.cycle_days,
                total_earned: purchase.total_earned || 0,
                quantity: purchase.quantity,
                status: purchase.status,
                purchase_date: purchase.purchase_date,
                expiry_date: purchase.expiry_date,
                next_payout: purchase.next_payout,
                cycle_days: purchase.cycle_days,
                days_remaining: daysRemaining,
                payout_count: purchase.payout_count || 0,
                can_collect: canCollect,
                last_payout: purchase.last_payout
            };
        });

        res.json({
            success: true,
            data: formattedPurchases
        });

    } catch (error) {
        console.error('Erro ao buscar compras:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar seus pacotes'
        });
    }
});

// 2. ROTA PARA COLETAR RENDIMENTO DE UM PRODUTO
app.post('/api/tasks/collect-product-income', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { product_id } = req.body;

        if (!product_id) {
            return res.status(400).json({
                success: false,
                message: 'ID do produto é obrigatório'
            });
        }

        // Buscar a compra
        const purchase = await prisma.purchase.findFirst({
            where: {
                id: product_id,
                user_id: userId,
                status: 'active'
            }
        });

        if (!purchase) {
            return res.status(404).json({
                success: false,
                message: 'Produto não encontrado ou não está ativo'
            });
        }

        const today = new Date();
        
        // Verificar se já expirou
        if (today > new Date(purchase.expiry_date)) {
            // Atualizar para completed
            await prisma.purchase.update({
                where: { id: purchase.id },
                data: { status: 'completed' }
            });
            
            return res.status(400).json({
                success: false,
                message: 'Este produto já expirou'
            });
        }

        // Verificar se já coletou hoje
        if (purchase.last_payout) {
            const lastPayout = new Date(purchase.last_payout);
            const sameDay = lastPayout.getDate() === today.getDate() &&
                           lastPayout.getMonth() === today.getMonth() &&
                           lastPayout.getFullYear() === today.getFullYear();
            
            if (sameDay) {
                return res.status(400).json({
                    success: false,
                    message: 'Você já coletou o rendimento hoje'
                });
            }
        }

        const dailyIncome = purchase.daily_return || 0;

        // Usar transaction para garantir consistência
        const result = await prisma.$transaction(async (tx) => {
            // 1. Atualizar saldo do usuário
            const user = await tx.user.update({
                where: { id: userId },
                data: {
                    saldo: {
                        increment: dailyIncome
                    }
                },
                select: {
                    saldo: true
                }
            });

            // 2. Atualizar a compra
            const updatedPurchase = await tx.purchase.update({
                where: { id: purchase.id },
                data: {
                    last_payout: today,
                    total_earned: {
                        increment: dailyIncome
                    },
                    payout_count: {
                        increment: 1
                    },
                    next_payout: new Date(today.getTime() + 24 * 60 * 60 * 1000)
                }
            });

            // 3. Registrar transação
            await tx.transaction.create({
                data: {
                    user_id: userId,
                    type: 'income',
                    amount: dailyIncome,
                    description: `Rendimento do produto: ${purchase.product_name}`,
                    balance_after: user.saldo,
                    created_at: today
                }
            });

            return {
                income: dailyIncome,
                new_balance: user.saldo,
                purchase: updatedPurchase
            };
        });

        res.json({
            success: true,
            message: 'Rendimento coletado com sucesso!',
            data: {
                income: result.income,
                new_balance: result.new_balance
            }
        });

    } catch (error) {
        console.error('Erro ao coletar rendimento:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao coletar rendimento'
        });
    }
});

// 3. ROTA PARA COLETAR TODOS OS RENDIMENTOS
app.post('/api/tasks/collect-all-income', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const today = new Date();

        // Buscar todas as compras ativas que podem ser coletadas
        const activePurchases = await prisma.purchase.findMany({
            where: {
                user_id: userId,
                status: 'active',
                expiry_date: {
                    gt: today
                }
            }
        });

        if (activePurchases.length === 0) {
            return res.json({
                success: true,
                message: 'Nenhum produto disponível para coleta',
                data: {
                    total_income: 0,
                    new_balance: 0
                }
            });
        }

        // Filtrar apenas os que podem ser coletados hoje
        const collectablePurchases = activePurchases.filter(purchase => {
            if (!purchase.last_payout) return true;
            
            const lastPayout = new Date(purchase.last_payout);
            const sameDay = lastPayout.getDate() === today.getDate() &&
                           lastPayout.getMonth() === today.getMonth() &&
                           lastPayout.getFullYear() === today.getFullYear();
            return !sameDay;
        });

        if (collectablePurchases.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Você já coletou todos os rendimentos hoje'
            });
        }

        // Calcular total
        let totalIncome = 0;
        collectablePurchases.forEach(purchase => {
            totalIncome += purchase.daily_return || 0;
        });

        // Processar em transaction
        const result = await prisma.$transaction(async (tx) => {
            // 1. Atualizar saldo do usuário
            const user = await tx.user.update({
                where: { id: userId },
                data: {
                    saldo: {
                        increment: totalIncome
                    }
                },
                select: {
                    saldo: true
                }
            });

            // 2. Atualizar cada compra
            for (const purchase of collectablePurchases) {
                await tx.purchase.update({
                    where: { id: purchase.id },
                    data: {
                        last_payout: today,
                        total_earned: {
                            increment: purchase.daily_return
                        },
                        payout_count: {
                            increment: 1
                        },
                        next_payout: new Date(today.getTime() + 24 * 60 * 60 * 1000)
                    }
                });
            }

            // 3. Registrar transação
            await tx.transaction.create({
                data: {
                    user_id: userId,
                    type: 'income',
                    amount: totalIncome,
                    description: `Rendimentos de ${collectablePurchases.length} produtos`,
                    balance_after: user.saldo,
                    created_at: today
                }
            });

            return {
                total_income: totalIncome,
                new_balance: user.saldo,
                products_collected: collectablePurchases.length
            };
        });

        res.json({
            success: true,
            message: `Rendimentos coletados de ${result.products_collected} produtos!`,
            data: result
        });

    } catch (error) {
        console.error('Erro ao coletar todos os rendimentos:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao coletar rendimentos'
        });
    }
});

// 4. ROTA PARA ESTATÍSTICAS
app.get('/api/user/packages-stats', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        // Buscar todas as compras
        const purchases = await prisma.purchase.findMany({
            where: {
                user_id: userId
            }
        });

        // Calcular estatísticas
        const totalPackages = purchases.length;
        const activePackages = purchases.filter(p => p.status === 'active').length;
        const completedPackages = purchases.filter(p => p.status === 'completed').length;
        
        const dailyIncome = purchases
            .filter(p => p.status === 'active')
            .reduce((sum, p) => sum + (p.daily_return || 0), 0);

        const totalEarned = purchases.reduce((sum, p) => sum + (p.total_earned || 0), 0);
        const totalInvested = purchases.reduce((sum, p) => sum + (p.amount || 0), 0);
        const netProfit = totalEarned - totalInvested;

        res.json({
            success: true,
            data: {
                total_packages: totalPackages,
                active_packages: activePackages,
                completed_packages: completedPackages,
                daily_income: dailyIncome,
                total_earned: totalEarned,
                total_invested: totalInvested,
                net_profit: netProfit
            }
        });

    } catch (error) {
        console.error('Erro ao buscar estatísticas:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar estatísticas'
        });
    }
});

// 5. ROTA PARA PACOTES RECENTES (OPCIONAL)
app.get('/api/user/recent-purchases', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const recentPurchases = await prisma.purchase.findMany({
            where: {
                user_id: userId
            },
            orderBy: {
                purchase_date: 'desc'
            },
            take: 5
        });

        res.json({
            success: true,
            data: {
                recent_purchases: recentPurchases,
                total: recentPurchases.length
            }
        });

    } catch (error) {
        console.error('Erro ao buscar compras recentes:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao buscar compras recentes'
        });
    }
});



// Rota para atualizar conta bancária
app.put('/api/user/bank-account', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { bank_name, account_holder, account_number, branch_code } = req.body;
        
        // Validar dados
        if (!bank_name || !account_holder || !account_number || !branch_code) {
            return res.status(400).json({
                success: false,
                message: 'Todos os campos são obrigatórios'
            });
        }

        // Verificar se existe conta bancária
        const existingAccount = await prisma.bankAccount.findUnique({
            where: { user_id: userId }
        });

        if (!existingAccount) {
            return res.status(404).json({
                success: false,
                message: 'Conta bancária não encontrada. Use a rota de criação.'
            });
        }

        // Atualizar conta bancária
        const bankAccount = await prisma.bankAccount.update({
            where: { user_id: userId },
            data: {
                bank_name: bank_name,
                account_holder: account_holder,
                account_number: account_number,
                branch_code: branch_code,
                updated_at: new Date()
            },
            select: {
                id: true,
                bank_name: true,
                account_holder: true,
                account_number: true,
                branch_code: true,
                created_at: true,
                updated_at: true
            }
        });

        // Registrar log
        await prisma.systemLog.create({
            data: {
                action: 'BANK_ACCOUNT_UPDATED',
                description: `Usuário atualizou conta bancária: ${bank_name} - ${account_number}`,
                user_id: userId,
                created_at: new Date()
            }
        });

        res.json({
            success: true,
            message: 'Conta bancária atualizada com sucesso!',
            data: bankAccount
        });

    } catch (error) {
        console.error('Erro ao atualizar conta bancária:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para deletar conta bancária
app.delete('/api/user/bank-account', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        // Verificar se existe conta bancária
        const existingAccount = await prisma.bankAccount.findUnique({
            where: { user_id: userId }
        });

        if (!existingAccount) {
            return res.status(404).json({
                success: false,
                message: 'Conta bancária não encontrada'
            });
        }

        // Deletar conta bancária
        await prisma.bankAccount.delete({
            where: { user_id: userId }
        });

        // Registrar log
        await prisma.systemLog.create({
            data: {
                action: 'BANK_ACCOUNT_DELETED',
                description: `Usuário deletou conta bancária`,
                user_id: userId,
                created_at: new Date()
            }
        });

        res.json({
            success: true,
            message: 'Conta bancária deletada com sucesso!'
        });

    } catch (error) {
        console.error('Erro ao deletar conta bancária:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para verificar se usuário tem conta bancária (para validação de saque)
app.get('/api/user/bank-account/check', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const bankAccount = await prisma.bankAccount.findUnique({
            where: { user_id: userId },
            select: {
                id: true,
                bank_name: true,
                account_holder: true
            }
        });

        res.json({
            success: true,
            data: {
                has_bank_account: !!bankAccount,
                bank_account: bankAccount
            }
        });

    } catch (error) {
        console.error('Erro ao verificar conta bancária:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});
// ==============================================
// CORREÇÃO DA ROTA DE ESTATÍSTICAS
// ==============================================

// Rota para admin2 - estatísticas gerais (CORRIGIDA)
app.get('/api/admin2/statistics', requireAdmin2, async (req, res) => {
    try {
        // Executar todas as consultas em paralelo para melhor performance
        const [
            totalUsers,
            totalBalanceResult,
            totalPurchases,
            usersWithPurchasesCount,
            pendingWithdrawals,
            pendingDeposits
        ] = await Promise.all([
            // Total de usuários
            prisma.user.count(),
            
            // Saldo total
            prisma.user.aggregate({
                _sum: { saldo: true }
            }),
            
            // Total de compras
            prisma.purchase.count(),
            
            // Usuários com pelo menos 1 compra (aproximação)
            prisma.user.count({
                where: {
                    purchases: {
                        some: {}
                    }
                }
            }),
            
            // Saques pendentes
            prisma.withdrawal.count({
                where: { status: 'pending' }
            }),
            
            // Depósitos pendentes
            prisma.deposit.count({
                where: { status: 'pending' }
            })
        ]);

        const totalBalance = totalBalanceResult._sum.saldo || 0;

        res.json({
            success: true,
            data: {
                total_users: totalUsers,
                total_balance: totalBalance,
                total_purchases: totalPurchases,
                users_with_purchases: usersWithPurchasesCount, // Usuários com pelo menos 1 compra
                users_with_2plus_purchases: usersWithPurchasesCount, // Para simplificar, use o mesmo valor
                pending_withdrawals: pendingWithdrawals,
                pending_deposits: pendingDeposits,
                average_balance: totalUsers > 0 ? totalBalance / totalUsers : 0
            }
        });

    } catch (error) {
        console.error('Erro ao buscar estatísticas:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor: ' + error.message
        });
    }
});



// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    
    prisma.$connect()
        .then(() => console.log('Conectado ao banco de dados'))
        .catch(err => console.error('Erro na conexão com o banco:', err));
});

// Graceful shutdown
process.on('SIGINT', async () => {
    await prisma.$disconnect();
    process.exit(0);
});
