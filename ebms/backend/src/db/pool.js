import pg from 'pg';

const { Pool } = pg;

export function createPool(database) {
  const pool = new Pool({ ...database, application_name: 'ebms-backend' });
  pool.on('error', (err) => console.error('[ebms] idle client error', err));
  return pool;
}
