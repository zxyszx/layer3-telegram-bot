export function createBillingAwareLayer3(layer3, billing, logger = { error() {} }) {
  async function billingCall(method, ...args) {
    try {
      return await billing[method](...args);
    } catch (error) {
      logger.error(`[BILLING] ${method} hook failed`, { error: error.message });
      return null;
    }
  }

  return {
    status: () => layer3.status(),

    async start() {
      const startedBilling = await billingCall('beginRun');
      const session = startedBilling?.session || null;
      let result;
      try {
        result = await layer3.start();
      } catch (error) {
        await billingCall('markStartFailed', session?.run_id, error);
        throw error;
      }
      await billingCall('markStarted', session?.run_id);
      return { ...result, billingRunId: session?.run_id || null };
    },

    async stop() {
      await billingCall('beforeShutdownAttempt');
      let result;
      try {
        result = await layer3.stop();
      } catch (error) {
        await billingCall('markShutdownFailure', error);
        throw error;
      }
      await billingCall('markShutdownSucceeded', result.status);
      return result;
    },
  };
}
