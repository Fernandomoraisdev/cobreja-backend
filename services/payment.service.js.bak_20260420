function calculateUpdatedTotal(debt) {
  const today = new Date();
  let updatedTotal = debt.total;
  let daysLate = 0;
  let lateFee = 0;

  if (today > debt.dueDate) {
    const diffTime = today - new Date(debt.dueDate);
    daysLate = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    lateFee = daysLate * debt.dailyFee;
    updatedTotal = debt.total + lateFee;
  }

  return {
    updatedTotal,
    daysLate,
    lateFee
  };
}

function applyPaymentRules(debt, paymentAmount, paymentType) {
  const { updatedTotal, lateFee } = calculateUpdatedTotal(debt);

  if (paymentType === 'total') {
    return {
      newTotal: 0,
      paidAmount: updatedTotal
    };
  }

  if (paymentType === 'juros') {
    const jurosPago = Math.min(paymentAmount, lateFee);
    return {
      newTotal: updatedTotal - jurosPago,
      paidAmount: jurosPago
    };
  }

  if (paymentType === 'parcial') {
    if (paymentAmount <= 0) {
      throw new Error('Valor do pagamento parcial deve ser maior que zero');
    }

    return {
      newTotal: Math.max(updatedTotal - paymentAmount, 0),
      paidAmount: paymentAmount
    };
  }

  throw new Error('Tipo de pagamento inválido');
}

module.exports = {
  calculateUpdatedTotal,
  applyPaymentRules
};
