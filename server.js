"use strict"

var constants = require("./server-constants.json");
var pg = require("pg");
var _ = require("lodash");
var url = require("url");

// Configure and initialize the Postgres connection pool
// Get the DATABASE_URL config var and parse it into its components
var params = url.parse(process.env.HEROKU_POSTGRESQL_COPPER_URL);
var auth = params.auth.split(":");
var pgConfig = {
	user: auth[0],
	password: auth[1],
	host: params.hostname,
	port: params.port,
	database: params.pathname.split("/")[1],
	ssl: true,
	max: 10,					// Maximum number of clients in the pool
	idleTimeoutMillis: 30000	// Duration a client can remain idle before being closed
};
var pool = new pg.Pool(pgConfig);

// Create an Express server
var express = require("express");
var server = express();

// Serve static files, including the Vue application in public/index.html
server.use(express.static("public"));
server.use(express.static("node_modules/vue/dist"));
server.use(express.static("node_modules/vue-router/dist"));
server.use(express.static("node_modules/lodash"));

//
// Handle GET request for players api
//

server.get("/api/players/", function(request, response) {

	// Create query string
	var queryString = "SELECT s.team, s.player_id, r.first, r.last, r.position, s.score_sit, s.strength_sit,"
		+ "		SUM(toi) AS toi, SUM(ig) AS ig, SUM(\"is\") AS \"is\", (SUM(\"is\") + SUM(ibs) + SUM(ims)) AS ic, SUM(ia1) AS ia1, SUM(ia2) AS ia2,"
		+ "		SUM(gf) AS gf, SUM(ga) AS ga, SUM(sf) AS sf, SUM(sa) AS sa, (SUM(sf) + SUM(bsf) + SUM(msf)) AS cf, (SUM(sa) + SUM(bsa) + SUM(msa)) AS ca,"
		+ "		SUM(cf_off) AS cf_off, SUM(ca_off) AS ca_off " 
		+ " FROM game_stats AS s"
		+ " 	LEFT JOIN game_rosters AS r"
		+ " 	ON s.player_id = r.player_id AND s.season = r.season AND s.game_id = r.game_id"
		+ " WHERE s.player_id > 0 AND r.position <> 'na' AND r.position <> 'g'"
		+ " GROUP BY s.team, s.player_id, r.first, r.last, r.position, s.score_sit, s.strength_sit";

	// Run query
	pool.connect(function(err, client, done) {
		if (err) { returnError("Error fetching client from pool: " + err); }
		client.query(queryString, function(err, result) {
			done(); // Return client to pool
			if (err) { returnError("Error running query: " + err); }
			processResults(result.rows);
		});
	});

	// Return errors
	function returnError(responseStr) {
		return response
			.status(500)
			.send(responseStr);
	}

	// Process query results
	function processResults(rows) {

		// rows is an array of Anonymous objects - use stringify and parse to convert it to json
		rows = JSON.parse(JSON.stringify(rows));

		// Postgres aggregate functions like SUM return strings, so cast them as ints
		rows.forEach(function(r) {
			["toi", "ig", "is", "ic", "ia1", "ia2", "gf", "ga", "sf", "sa", "cf", "ca", "cf_off", "ca_off"].forEach(function(col) {
				r[col] = +r[col];
			});
		});

		// Calculate score-adjusted corsi for each row
		rows.forEach(function(r) {
			r["cf_adj"] = constants["cfWeights"][r["score_sit"]] * r["cf"];
			r["ca_adj"] = constants["cfWeights"][-1 * r["score_sit"]] * r["ca"];
		});

		// Group rows by playerId:
		//	{ 123: [rows for player 123], 234: [rows for player 234] }
		var groupedRows = _.groupBy(rows, "player_id");

		// Structure results as an array of objects:
		// [ { playerId: 123, data: [rows for player 123] }, { playerId: 234, data: [rows for player 234] } ]
		var result = { players: [] };
		for (var pId in groupedRows) {
			if (!groupedRows.hasOwnProperty(pId)) {
				continue;
			}

			// Get all teams and positions the player has been on
			var teams = _.uniqBy(groupedRows[pId], "teams").map(function(d) { return d.team; });
			var positions = _.uniqBy(groupedRows[pId], "teams").map(function(d) { return d.position; });

			result["players"].push({
				player_id: +pId,
				teams: teams,
				positions: positions,
				first: groupedRows[pId][0]["first"],
				last: groupedRows[pId][0]["last"],
				data: groupedRows[pId]
			});

			// Set redundant properties in 'data' to be undefined - this removes them from the response
			// Setting the properties to undefined is ~10sec faster than deleting the properties completely
			result["players"].forEach(function(p) {
				p.data.forEach(function(r) {
					r.team = undefined;
					r.player_id = undefined;
					r.first = undefined;
					r.last = undefined;
					r.position = undefined;
				});
			});
		}

		return response
			.status(200)
			.send(result);
	}
});

//
// Handle GET request for teams api
//

server.get("/api/teams/", function(request, response) {

	// Create query string
	var queryString = "SELECT team, score_sit, strength_sit, SUM(toi) AS toi,"
		+ "		SUM(gf) AS gf, SUM(ga) AS ga, SUM(sf) AS sf, SUM(sa) AS sa, (SUM(sf) + SUM(bsf) + SUM(msf)) AS cf, (SUM(sa) + SUM(bsa) + SUM(msa)) AS ca"
		+ " FROM game_stats"
		+ " WHERE player_id = 0 "
		+ " GROUP BY team, score_sit, strength_sit";
	
	// Run query
	pool.connect(function(err, client, done) {
		if (err) { returnError("Error fetching client from pool: " + err); }
		client.query(queryString, function(err, result) {
			done(); // Return client to pool
			if (err) { returnError("Error running query: " + err); }
			processResults(result.rows);
		});
	});

	// Return errors
	function returnError(responseStr) {
		return response
			.status(500)
			.send(responseStr);
	}

	// Process query results
	function processResults(rows) {

		// rows is an array of Anonymous objects - use stringify and parse to convert it to json
		rows = JSON.parse(JSON.stringify(rows));

		// Postgres aggregate functions like SUM return strings, so cast them as ints
		rows.forEach(function(r) {
			["toi", "gf", "ga", "sf", "sa", "cf", "ca"].forEach(function(col) {
				r[col] = +r[col];
			});
		});

		// Calculate score-adjusted corsi for each row
		rows.forEach(function(r) {
			r["cf_adj"] = constants["cfWeights"][r["score_sit"]] * r["cf"];
			r["ca_adj"] = constants["cfWeights"][-1 * r["score_sit"]] * r["ca"];
		});

		// Group rows by team:
		// { "edm": [rows for edm], "tor": [rows for tor] }
		var groupedRows = _.groupBy(rows, "team");		

		// Structure results as an array of objects:
		// [ { team: "edm", data: [rows for edm] }, { team: "tor", data: [rows for tor] } ]
		var result = { teams: [] };
		for (var tricode in groupedRows) {
			if (!groupedRows.hasOwnProperty(tricode)) {
				continue;
			}
			result["teams"].push({
				team: tricode,
				data: groupedRows[tricode]
			});
		}

		return response
			.status(200)
			.send(result);
	}
});

// Start listening for requests
server.listen(process.env.PORT || 5000, function(error) {
	if (error) { throw error; }
	console.log("Server is running at localhost:5000");
});