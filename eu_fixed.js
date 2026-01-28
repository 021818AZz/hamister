const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const cron = require('node-cron');
const app = express();
const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET || 'seu_segredo_jwt_super_seguro_aqui';
const uploadRouter = require('./upload');
const prisma = new PrismaClient({
  log: ['query', 'error', 'warn'],
  transactionOptions: { maxWait: 10000, timeout: 30000 }
});

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => { console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`); next(); });
app.use('/upload', uploadRouter);

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'Token de acesso necessário' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: decoded.userId }, select: { id: true, mobile: true } });
    if (!user) return res.status(401).json({ success: false, message: 'Usuário não encontrado' });
    req.user = user; next();
  } catch (error) {
    console.error('Erro na autenticação:', error);
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') return res.status(403).json({ success: false, message: 'Token inválido ou expirado' });
    res.status(500).json({ success: false, message: 'Erro na autenticação' });
  }
};

const authenticateSystem = (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'Token de sistema necessário' });
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.system !== true) return res.status(403).json({ success: false, message: 'Token de sistema inválido' });
    next();
  } catch (error) { console.error('Erro na autenticação do sistema:', error); res.status(403).json({ success: false, message: 'Token de sistema inválido' }); }
};

app.post('/api/process-daily-payouts', authenticateSystem, async (req, res) => {
  try {
    const now = new Date();
    const duePurchases = await prisma.purchase.findMany({ where: { status: 'active', next_payout: { lte: now }, expiry_date: { gt: now } }, include: { user: { select: { id: true, mobile: true, saldo: true } } } });
    if (duePurchases.length === 0) return res.json({ success: true, message: 'Nenhum rendimento para processar hoje', data: { processed: 0, total_amount: 0, timestamp: now.toISOString() } });
    let processedCount = 0; let totalAmount = 0; const results = []; const errors = [];

    for (const purchase of duePurchases) {
      try {
        const nextPayout = new Date(purchase.next_payout); nextPayout.setHours(nextPayout.getHours() + 24);
        const daysPassed = Math.floor((now - purchase.purchase_date) / (1000 * 60 * 60 * 24));
        const remainingDays = (purchase.cycle_days || 30) - daysPassed;
        if (remainingDays <= 0) { await prisma.purchase.update({ where: { id: purchase.id }, data: { status: 'completed', completed_at: new Date() } }); results.push({ purchase_id: purchase.id, user_id: purchase.user_id, user_mobile: purchase.user.mobile, status: 'completed', message: 'Produto completou o ciclo' }); continue; }
        const dailyReturn = purchase.daily_return || 13;
        await prisma.$transaction(async (tx) => {
          const updatedUser = await tx.user.update({ where: { id: purchase.user_id }, data: { saldo: { increment: dailyReturn } }, select: { saldo: true } });
          await tx.purchase.update({ where: { id: purchase.id }, data: { next_payout: nextPayout, total_earned: { increment: dailyReturn }, payout_count: { increment: 1 }, last_payout: new Date() } });
          await tx.transaction.create({ data: { user_id: purchase.user_id, type: 'daily_payout_auto', amount: dailyReturn, description: `Rendimento automático: ${purchase.product_name}`, balance_after: updatedUser.saldo, created_at: new Date() } });
          await tx.systemLog.create({ data: { action: 'AUTO_DAILY_PAYOUT', description: `Rendimento automático de ${dailyReturn} KZ para ${purchase.user.mobile}. Produto: ${purchase.product_name}`, user_id: purchase.user_id, created_at: new Date() } });
        });
        processedCount++; totalAmount += dailyReturn; results.push({ purchase_id: purchase.id, user_id: purchase.user_id, user_mobile: purchase.user.mobile, amount: dailyReturn, next_payout: nextPayout, status: 'success' });
      } catch (purchaseError) { console.error(`Erro processando compra ${purchase.id}:`, purchaseError); errors.push({ purchase_id: purchase.id, user_id: purchase.user_id, error: purchaseError.message }); }
    }

    await prisma.systemLog.create({ data: { action: 'AUTO_PAYOUTS_COMPLETED', description: `Processamento automático concluído: ${processedCount} rendimentos processados, total: ${totalAmount} KZ. Erros: ${errors.length}`, created_at: new Date() } });
    res.json({ success: true, message: `Processamento automático concluído: ${processedCount} rendimentos, total: ${totalAmount} KZ`, data: { processed: processedCount, total_amount: totalAmount, timestamp: now.toISOString(), results, errors } });
  } catch (error) { console.error('Erro no processamento automático:', error); await prisma.systemLog.create({ data: { action: 'AUTO_PAYOUTS_ERROR', description: `Erro no processamento automático: ${error.message}`, created_at: new Date() } }); res.status(500).json({ success: false, message: 'Erro no processamento automático', error: error.message, timestamp: new Date().toISOString() }); }
});

async function executeAutoPayouts() {
  try { console.log('Cron job executando processamento de rendimentos...'); const token = jwt.sign({ system: true }, JWT_SECRET); const response = await fetch(`http://localhost:${PORT}/api/process-daily-payouts`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` } }); const result = await response.json(); console.log('Resultado do cron job:', result.message || result); return result; } catch (error) { console.error('Erro no cron job:', error); return { success: false, error: error.message }; }
}
if (process.env.NODE_ENV === 'production') { cron.schedule('0 0 * * *', async () => { console.log('Cron job acionado (meia-noite)'); await executeAutoPayouts(); }, { timezone: 'Africa/Luanda' }); console.log('Cron job configurado para rodar diariamente às 00:00'); }
app.post('/api/test-auto-payouts', authenticateSystem, async (req, res) => { try { const result = await executeAutoPayouts(); res.json(result); } catch (error) { res.status(500).json({ success: false, error: error.message }); } });

app.get('/api/system/health', async (req, res) => { res.json({ success: true, data: { service: 'Auto Payout System', status: 'operational', timestamp: new Date().toISOString(), version: '2.0.0' } }); });

app.get('/api/system/payouts-status', authenticateToken, async (req, res) => { try { if (req.user.id !== 'admin') return res.status(403).json({ success: false, message: 'Acesso negado' }); const now = new Date(); const pendingCount = await prisma.purchase.count({ where: { status: 'active', next_payout: { lte: now }, expiry_date: { gt: now } } }); const lastLogs = await prisma.systemLog.findMany({ where: { action: { in: ['AUTO_DAILY_PAYOUT', 'AUTO_PAYOUTS_COMPLETED'] } }, orderBy: { created_at: 'desc' }, take: 5 }); const today = new Date(); today.setHours(0,0,0,0); const todayPayouts = await prisma.transaction.count({ where: { type: 'daily_payout_auto', created_at: { gte: today } } }); const totalPayouts = await prisma.transaction.count({ where: { type: 'daily_payout_auto' } }); const totalAmount = await prisma.transaction.aggregate({ where: { type: 'daily_payout_auto' }, _sum: { amount: true } }); res.json({ success: true, data: { system: 'active', cron_job_active: true, pending_today: pendingCount, statistics: { today_payouts: todayPayouts, total_payouts: totalPayouts, total_amount: totalAmount._sum.amount || 0 }, next_run: '00:00 (todos os dias)', timezone: 'Africa/Luanda', recent_activity: lastLogs.map(l => ({ time: l.created_at, action: l.action, description: l.description })) } }); } catch (error) { console.error('Erro ao verificar status:', error); res.status(500).json({ success: false, message: 'Erro ao verificar status' }); } });

app.get('/api/user/purchases', authenticateToken, async (req, res) => { try { const userId = req.user.id; const purchases = await prisma.purchase.findMany({ where: { user_id: userId }, orderBy: { purchase_date: 'desc' } }); const formatted = purchases.map(p => { const today = new Date(); const expiryDate = new Date(p.expiry_date); const nextPayout = new Date(p.next_payout); const daysRemaining = Math.max(0, Math.ceil((expiryDate - today) / (1000*60*60*24))); const progress = p.payout_count > 0 ? Math.min(100, Math.round((p.payout_count / p.cycle_days) * 100)) : 0; let displayStatus = p.status; let statusMessage = ''; if (p.status === 'active') { if (daysRemaining <= 0) { displayStatus = 'expired'; statusMessage = 'Produto expirado'; } else if (nextPayout <= today) { statusMessage = 'Rendimento pendente (sistema automático)'; } else { statusMessage = `Próximo rendimento: ${nextPayout.toLocaleTimeString('pt-AO', { hour: '2-digit', minute: '2-digit' })}`; } } return { id: p.id, product_id: p.product_id, product_name: p.product_name || 'Produto', amount: p.amount, daily_return: p.daily_return, total_return: (p.daily_return||0)*(p.cycle_days||0), total_earned: p.total_earned||0, quantity: p.quantity, status: displayStatus, status_message: statusMessage, purchase_date: p.purchase_date, expiry_date: p.expiry_date, next_payout: p.next_payout, cycle_days: p.cycle_days, days_remaining: daysRemaining, payout_count: p.payout_count||0, last_payout: p.last_payout, progress_percentage: progress, payout_system: 'automático', info: 'Rendimentos são creditados automaticamente todos os dias' }; }); res.json({ success: true, data: formatted }); } catch (error) { console.error('Erro ao buscar compras:', error); res.status(500).json({ success: false, message: 'Erro ao buscar seus pacotes' }); } });

app.get('/api/user/packages-stats', authenticateToken, async (req, res) => { try { const userId = req.user.id; const purchases = await prisma.purchase.findMany({ where: { user_id: userId } }); const today = new Date(); const activePurchases = purchases.filter(p => new Date(p.expiry_date) > today && p.status === 'active'); const totalPackages = purchases.length; const activePackages = activePurchases.length; const completedPackages = purchases.filter(p => p.status === 'completed').length; const dailyIncome = activePurchases.reduce((s,p) => s + (p.daily_return||0),0); const totalEarned = purchases.reduce((s,p) => s + (p.total_earned||0),0); const totalInvested = purchases.reduce((s,p) => s + (p.amount||0),0); const netProfit = totalEarned - totalInvested; const nextPayout = activePurchases.length > 0 ? activePurchases.reduce((earliest,p) => new Date(p.next_payout) < new Date(earliest.next_payout) ? p : earliest) : null; res.json({ success: true, data: { total_packages: totalPackages, active_packages: activePackages, completed_packages: completedPackages, daily_income: dailyIncome, total_earned: totalEarned, total_invested: totalInvested, net_profit: netProfit, next_auto_payout: nextPayout ? { time: nextPayout.next_payout, product: nextPayout.product_name, amount: nextPayout.daily_return } : null, payout_system: { type: 'automático', description: 'Rendimentos creditados automaticamente todos os dias', schedule: 'Diariamente às 00:00', timezone: 'Africa/Luanda' } } }); } catch (error) { console.error('Erro ao buscar estatísticas:', error); res.status(500).json({ success: false, message: 'Erro ao buscar estatísticas' }); } });

const requireAdmin = (req, res, next) => { const adminToken = req.headers['authorization']?.replace('Bearer ', ''); if (adminToken === 'admin_secret_token_123') return next(); return res.status(403).json({ success: false, message: 'Acesso não autorizado. Token de administrador necessário.' }); };
app.get('/api/admin/users', requireAdmin, async (req, res) => { try { const users = await prisma.user.findMany({ select: { id: true, mobile: true, saldo: true, invitation_code: true, created_at: true, _count: { select: { purchases: true, referralLevels: true } } }, orderBy: { created_at: 'desc' } }); const formattedUsers = users.map(u => ({ id: u.id, mobile: u.mobile, saldo: u.saldo, invitation_code: u.invitation_code, created_at: u.created_at, purchase_count: u._count.purchases, referral_count: u._count.referralLevels })); const totalBalance = users.reduce((s,u) => s + (u.saldo||0),0); res.json({ success: true, data: { users: formattedUsers, total: users.length, total_balance: totalBalance } }); } catch (error) { console.error('Erro ao listar usuários:', error); res.status(500).json({ success: false, message: 'Erro ao listar usuários' }); } });

app.listen(PORT, '0.0.0.0', () => { console.log(`Servidor rodando na porta ${PORT}`); prisma.$connect().then(() => console.log('Conectado ao banco de dados')).catch(err => { console.error('Erro na conexão com o banco:', err); process.exit(1); }); });
process.on('SIGINT', async () => { console.log('Desligando servidor...'); await prisma.$disconnect(); console.log('Servidor desligado'); process.exit(0); });
