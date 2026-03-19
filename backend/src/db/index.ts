import { Pool } from 'pg';

// Single pool instance shared across all requests.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  console.error('Unexpected DB client error', err);
});

/** Acquires and immediately releases a client to verify connectivity. */
export async function checkConnection(): Promise<void> {
  const client = await pool.connect();
  client.release();
}

export default pool;
