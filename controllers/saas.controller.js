const { writeAuditLog } = require('../services/audit.service');
const {
  changeAccountPlan,
  getSaasOverview,
  serializeSubscription,
} = require('../services/saas.service');

async function getSaasStatus(req, res) {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ message: 'Apenas ADMIN pode consultar planos', data: {} });
    }

    const overview = await getSaasOverview(req.user.accountId);
    return res.json({
      message: 'Plano carregado com sucesso',
      data: overview,
    });
  } catch (err) {
    console.error('Erro ao carregar SaaS:', err);
    return res.status(500).json({
      message: err.message || 'Erro ao carregar plano',
      data: {},
    });
  }
}

async function selectSaasPlan(req, res) {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ message: 'Apenas ADMIN pode alterar plano', data: {} });
    }

    const planCode = String(req.body.planCode || req.body.code || '').trim().toUpperCase();
    if (!planCode) {
      return res.status(400).json({ message: 'planCode e obrigatorio', data: {} });
    }

    const subscription = await changeAccountPlan({
      accountId: req.user.accountId,
      planCode,
      status: planCode === 'FREE' ? 'TRIAL' : 'ACTIVE',
    });

    await writeAuditLog({
      req,
      action: 'SAAS_PLAN_CHANGED',
      entity: 'Subscription',
      entityId: subscription.id,
      severity: 'INFO',
      metadata: {
        planCode,
        planName: subscription.plan?.name,
        status: subscription.status,
      },
    });

    const overview = await getSaasOverview(req.user.accountId);
    return res.json({
      message: 'Plano atualizado com sucesso',
      data: {
        subscription: serializeSubscription(subscription),
        overview,
      },
    });
  } catch (err) {
    console.error('Erro ao alterar plano:', err);
    return res.status(err.statusCode || 500).json({
      message: err.message || 'Erro ao alterar plano',
      data: err.data || {},
    });
  }
}

module.exports = {
  getSaasStatus,
  selectSaasPlan,
};
