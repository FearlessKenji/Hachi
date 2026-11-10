// Drain in-flight bot work before closing SQLite during a normal PM2 stop.
// PM2 still has a final kill timeout, so an unresponsive provider cannot hold
// shutdown open indefinitely.
function waitForSettledWork(work, timeoutMs) {
	let timeout;
	const deadline = new Promise(resolve => {
		timeout = setTimeout(() => resolve(false), timeoutMs);
	});
	return Promise.race([
		Promise.allSettled(work).then(() => true),
		deadline,
	]).finally(() => clearTimeout(timeout));
}

async function drainAndCloseRuntime({
	activeEvents,
	client,
	cronJobs,
	database,
	drainTimeoutMs,
	logger,
	replayWaiters,
	stopAuthRefresh,
	stopEventSub,
	stopReadyTasks,
	stopLogCleanup,
}) {
	const pendingWork = [];

	for (const [name, job] of Object.entries(cronJobs || {})) {
		try {
			pendingWork.push(Promise.resolve(job.stop()));
			logger.info(`${name} cron stopped.`);
		} catch (err) {
			logger.error(`Could not stop ${name} cron.`, err, { module: `shutdown` });
		}
	}

	// Stop new provider callbacks before waiting for requests already in flight.
	try {
		pendingWork.push(Promise.resolve(stopAuthRefresh()));
	} catch (err) {
		logger.error(`Could not stop OAuth refresh retries.`, err, { module: `shutdown` });
	}
	try {
		pendingWork.push(Promise.resolve(stopEventSub()));
	} catch (err) {
		logger.error(`Could not stop Twitch role EventSub.`, err, { module: `shutdown` });
	}
	try {
		pendingWork.push(Promise.resolve(stopReadyTasks()));
	} catch (err) {
		logger.error(`Could not stop ready-event reconciliation.`, err, { module: `shutdown` });
	}
	try {
		stopLogCleanup();
	} catch (err) {
		logger.error(`Could not stop log maintenance.`, err, { module: `shutdown` });
	}

	for (const waitForReplay of replayWaiters) {
		try {
			pendingWork.push(Promise.resolve(waitForReplay()));
		} catch (err) {
			logger.error(`Could not inspect pending replay work.`, err, { module: `shutdown` });
		}
	}
	pendingWork.push(...activeEvents);

	const settled = await waitForSettledWork(pendingWork, drainTimeoutMs);
	if (!settled) {
		// Closing SQLite while a callback still writes can turn a graceful stop
		// into a failed transaction. Process exit releases handles safely.
		logger.warn(`Shutdown drain timed out; leaving SQLite open for process exit.`, { module: `shutdown` });
	} else {
		try {
			await database.close();
			logger.info(`Database connections closed.`);
		} catch (err) {
			logger.error(`Could not close database connections during shutdown.`, err, { module: `shutdown` });
		}
	}

	try {
		await client.destroy();
	} catch (err) {
		logger.error(`Could not close Discord connection during shutdown.`, err, { module: `shutdown` });
	}
	return { drained: settled };
}

module.exports = { drainAndCloseRuntime };
