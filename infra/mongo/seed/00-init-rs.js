// Init single-node replica set — requis pour les transactions Mongo.
// Exécuté par docker-entrypoint-initdb.d AVANT 01-seed.js (préfixe alpha).
// Idempotent : si le RS est déjà init (rs.status() ok), on skip.

try {
	rs.status();
} catch (_) {
	rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "localhost:27017" }] });
	// Attend le primary avant que les seeds suivants insèrent des docs — sinon
	// insertMany échoue avec `NotWritablePrimary` pendant la fenêtre d'élection.
	let waited = 0;
	while (waited < 15000) {
		try {
			if (rs.status().myState === 1) break;
		} catch (_) {
			/* not ready yet */
		}
		sleep(500);
		waited += 500;
	}
}
