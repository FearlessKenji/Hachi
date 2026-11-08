// Bound replay cleanup independently from live alert delivery. A slow or
// permanently failing VoD lookup must not hold the next stream poll open.
const MAX_REPLAY_ROWS_PER_RUN = 40;
const MAX_CONCURRENT_REPLAYS = 4;

function selectReplayRows(rows, previousId, limit = MAX_REPLAY_ROWS_PER_RUN) {
	if (!rows.length) {
		return [];
	}
	const orderedRows = [...rows].sort((left, right) => left.id - right.id);
	const nextIndex = orderedRows.findIndex(row => row.id > previousId);
	const startIndex = nextIndex === -1 ? 0 : nextIndex;
	const rotatedRows = [...orderedRows.slice(startIndex), ...orderedRows.slice(0, startIndex)];
	return rotatedRows.slice(0, limit);
}

async function processReplayRows(rows, processRow, concurrency = MAX_CONCURRENT_REPLAYS) {
	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
		while (nextIndex < rows.length) {
			const row = rows[nextIndex];
			nextIndex += 1;
			await processRow(row);
		}
	});
	await Promise.all(workers);
}

module.exports = {
	processReplayRows,
	selectReplayRows,
};
