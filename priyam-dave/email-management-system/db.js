const { Pool } = require("pg");
const { pgConnectionString } = require("./config");

const pool = new Pool({
  connectionString: pgConnectionString
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
