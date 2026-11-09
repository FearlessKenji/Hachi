// Close SQLite connections after a transaction fails to commit or roll back.
//
// Sequelize's SQLite manager caches these connections outside its generic pool,
// but its inherited force-cleanup method only destroys pooled connections. A
// failed COMMIT can otherwise leave an open write transaction and journal that
// blocks every later database request until the process exits.
function installSqliteConnectionCleanup(database) {
	const manager = database.connectionManager;

	manager.destroyConnection = async connection => {
		// Both sqlite3 and Hachi's SQLCipher adapter support close(callback).
		// Keep a failed close in the cache so Sequelize can try again on shutdown.
		await new Promise((resolve, reject) => {
			connection.close(err => err ? reject(err) : resolve());
		});

		// Match by object, since in-memory SQLite uses a shared cache key instead
		// of the transaction UUID and a newer connection may reuse that key.
		for (const [key, cachedConnection] of Object.entries(manager.connections)) {
			if (cachedConnection === connection) {
				delete manager.connections[key];
			}
		}
	};
}

module.exports = { installSqliteConnectionCleanup };
