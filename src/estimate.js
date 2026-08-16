export function estimateUsage(balance, hourlyPrice, hoursPerDay = 1) {
  const remainingHours = balance / hourlyPrice;
  return {
    remainingHours,
    estimatedDays: remainingHours / hoursPerDay,
    estimatedYears: remainingHours / (hoursPerDay * 365),
  };
}

export function formatNgn(value, fractionDigits = 2) {
  return new Intl.NumberFormat('en-NG', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function formatInstanceStatus(status) {
  const labels = {
    RUNNING: '已启动',
    STOPPED: '已关机',
    STARTING: '启动中',
    STOPPING: '关机中',
    SUSPENDED: '已暂停',
    UNKNOWN: '未知',
  };
  return labels[status] || '未知';
}

export function formatStatusReport(status, config, autoStopAt = null) {
  const estimate = estimateUsage(status.balance, config.hourlyPrice, config.estimatedHoursPerDay);
  const autoStopLine = autoStopAt
    ? `\n自动关机：<b>${new Date(autoStopAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</b>`
    : '';

  return [
    `<b>${escapeHtml(config.instanceName)}</b>`,
    `状态：<b>${formatInstanceStatus(status.instanceStatus)}</b>`,
    `余额：<b>NGN ${formatNgn(status.balance)}</b>`,
    `参考单价：<b>NGN ${formatNgn(config.hourlyPrice, 5)}/小时</b>`,
    `预计可运行：<b>${formatNgn(estimate.remainingHours, 1)} 小时</b>`,
    `按每天 ${config.estimatedHoursPerDay} 小时：约 <b>${formatNgn(estimate.estimatedDays, 0)} 天</b> / <b>${formatNgn(estimate.estimatedYears, 1)} 年</b>${autoStopLine}`,
  ].join('\n');
}
