// =============================================================================
// Seed Script — Park Meadows Apartments
//
// Inserts a realistic 15-resident property with varied risk profiles.
// Idempotent: running it twice removes the previous data and re-inserts.
//
// Run: npm run seed
// =============================================================================

import 'dotenv/config';
import { PoolClient } from 'pg';
import pool from '../src/db';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROPERTY_NAME = 'Park Meadows Apartments';

// ---------------------------------------------------------------------------
// Resident definitions
// ---------------------------------------------------------------------------

interface ResidentDef {
  firstName:    string;
  lastName:     string;
  email:        string;
  /** Which unit this resident occupies (101–115). */
  unitNumber:   string;
  leaseType:    'fixed' | 'month_to_month';
  /**
   * Days from today to lease_end_date.
   * Positive = future expiry. Negative = already expired (MTM residents).
   */
  daysToExpiry: number;
  /** Current monthly_rent in the lease. */
  monthlyRent:  number;
  /** Most recent market_rent for this unit. */
  marketRent:   number;
  /**
   * Number of on-time payments in the last 6 months (0–6).
   * Missed = 6 − paymentCount.
   */
  paymentCount: number;
  /** Whether an active renewal offer has been sent. */
  hasOffer:     boolean;
}

// Expected risk scores (days + payment + offer + rent = total):
//   30+0+20+15=65   → HIGH
//   30+5+20+8=63    → MEDIUM
//   0+0+0+0=0       → LOW
//   20+0+20+15=55   → MEDIUM  (MTM → fixed days score = 20)
//   40+25+20+15=100 → HIGH
//   40+0+20+15=75   → HIGH
//   40+25+20+0=85   → HIGH
//   30+0+20+0=50    → MEDIUM
//   40+5+0+0=45     → MEDIUM
//   0+0+0+0=0       → LOW     (×7)
//
// Summary: 4 HIGH  |  4 MEDIUM  |  7 LOW  →  flaggedCount = 8 / 15 residents
const RESIDENTS: ResidentDef[] = [
  // ── Primary test scenarios (match seed_and_testing.md) ─────────────────
  {
    firstName: 'Jane',  lastName: 'Doe',
    email:     'jane.doe@example.com',
    unitNumber: '101', leaseType: 'fixed', daysToExpiry: 45,
    monthlyRent: 1400, marketRent: 1600, paymentCount: 6, hasOffer: false,
    // score: 30+0+20+15 = 65 → HIGH
  },
  {
    firstName: 'John',  lastName: 'Smith',
    email:     'john.smith@example.com',
    unitNumber: '102', leaseType: 'fixed', daysToExpiry: 60,
    monthlyRent: 1500, marketRent: 1600, paymentCount: 5, hasOffer: false,
    // score: 30+5+20+8 = 63 → MEDIUM
  },
  {
    firstName: 'Alice', lastName: 'Johnson',
    email:     'alice.johnson@example.com',
    unitNumber: '103', leaseType: 'fixed', daysToExpiry: 180,
    monthlyRent: 1600, marketRent: 1600, paymentCount: 6, hasOffer: true,
    // score: 0+0+0+0 = 0 → LOW
  },
  {
    firstName: 'Bob',   lastName: 'Williams',
    email:     'bob.williams@example.com',
    unitNumber: '104', leaseType: 'month_to_month', daysToExpiry: -365,
    monthlyRent: 1450, marketRent: 1600, paymentCount: 6, hasOffer: false,
    // score: 20(MTM)+0+20+15 = 55 → MEDIUM
  },
  // ── Additional residents ────────────────────────────────────────────────
  {
    firstName: 'Carol', lastName: 'Martinez',
    email:     'carol.martinez@example.com',
    unitNumber: '105', leaseType: 'fixed', daysToExpiry: 25,
    monthlyRent: 1300, marketRent: 1600, paymentCount: 3, hasOffer: false,
    // score: 40+25+20+15 = 100 → HIGH  [(1600-1300)/1300 = 23% > 10%]
  },
  {
    firstName: 'David', lastName: 'Lee',
    email:     'david.lee@example.com',
    unitNumber: '106', leaseType: 'fixed', daysToExpiry: 30,
    monthlyRent: 1400, marketRent: 1600, paymentCount: 6, hasOffer: false,
    // score: 40+0+20+15 = 75 → HIGH
  },
  {
    firstName: 'Henry', lastName: 'Anderson',
    email:     'henry.anderson@example.com',
    unitNumber: '107', leaseType: 'fixed', daysToExpiry: 25,
    monthlyRent: 1600, marketRent: 1600, paymentCount: 3, hasOffer: false,
    // score: 40+25+20+0 = 85 → HIGH
  },
  {
    firstName: 'Emma',  lastName: 'Wilson',
    email:     'emma.wilson@example.com',
    unitNumber: '108', leaseType: 'fixed', daysToExpiry: 50,
    monthlyRent: 1600, marketRent: 1600, paymentCount: 6, hasOffer: false,
    // score: 30+0+20+0 = 50 → MEDIUM
  },
  {
    firstName: 'Frank', lastName: 'Brown',
    email:     'frank.brown@example.com',
    unitNumber: '109', leaseType: 'fixed', daysToExpiry: 30,
    monthlyRent: 1600, marketRent: 1600, paymentCount: 5, hasOffer: true,
    // score: 40+5+0+0 = 45 → MEDIUM
  },
  {
    firstName: 'Karen', lastName: 'White',
    email:     'karen.white@example.com',
    unitNumber: '110', leaseType: 'fixed', daysToExpiry: 210,
    monthlyRent: 1600, marketRent: 1600, paymentCount: 6, hasOffer: true,
    // score: 0+0+0+0 = 0 → LOW
  },
  {
    firstName: 'Grace', lastName: 'Taylor',
    email:     'grace.taylor@example.com',
    unitNumber: '111', leaseType: 'fixed', daysToExpiry: 240,
    monthlyRent: 1600, marketRent: 1600, paymentCount: 6, hasOffer: true,
    // score: 0+0+0+0 = 0 → LOW
  },
  {
    firstName: 'Liam',  lastName: 'Harris',
    email:     'liam.harris@example.com',
    unitNumber: '112', leaseType: 'fixed', daysToExpiry: 100,
    monthlyRent: 1600, marketRent: 1600, paymentCount: 6, hasOffer: true,
    // score: 10+0+0+0 = 10 → LOW  [91–120 days = 10 pts]
  },
  {
    firstName: 'Iris',  lastName: 'Thomas',
    email:     'iris.thomas@example.com',
    unitNumber: '113', leaseType: 'fixed', daysToExpiry: 300,
    monthlyRent: 1600, marketRent: 1600, paymentCount: 6, hasOffer: true,
    // score: 0+0+0+0 = 0 → LOW
  },
  {
    firstName: 'James', lastName: 'Jackson',
    email:     'james.jackson@example.com',
    unitNumber: '114', leaseType: 'fixed', daysToExpiry: 200,
    monthlyRent: 1600, marketRent: 1600, paymentCount: 6, hasOffer: true,
    // score: 0+0+0+0 = 0 → LOW
  },
  {
    firstName: 'Mia',   lastName: 'Clark',
    email:     'mia.clark@example.com',
    unitNumber: '115', leaseType: 'fixed', daysToExpiry: 365,
    monthlyRent: 1600, marketRent: 1600, paymentCount: 6, hasOffer: true,
    // score: 0+0+0+0 = 0 → LOW
  },
];

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function toDateStr(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Reset (idempotent)
// ---------------------------------------------------------------------------

async function resetSeedData(client: PoolClient): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM properties WHERE name = $1`,
    [PROPERTY_NAME],
  );
  if (!rows.length) return;

  const propId = rows[0].id;
  console.log(`  Removing existing data for property ${propId}…`);

  // Delete in reverse FK dependency order (no ON DELETE CASCADE in schema).
  await client.query(
    `DELETE FROM webhook_dead_letter_queue
      WHERE webhook_delivery_state_id IN (
        SELECT id FROM webhook_delivery_state WHERE property_id = $1
      )`,
    [propId],
  );
  await client.query(`DELETE FROM webhook_delivery_state WHERE property_id = $1`, [propId]);
  await client.query(`DELETE FROM renewal_risk_scores     WHERE property_id = $1`, [propId]);
  await client.query(`DELETE FROM renewal_offers          WHERE property_id = $1`, [propId]);
  await client.query(`DELETE FROM resident_ledger         WHERE property_id = $1`, [propId]);
  await client.query(`DELETE FROM leases                  WHERE property_id = $1`, [propId]);
  await client.query(`DELETE FROM residents               WHERE property_id = $1`, [propId]);
  await client.query(
    `DELETE FROM unit_pricing
      WHERE unit_id IN (SELECT id FROM units WHERE property_id = $1)`,
    [propId],
  );
  await client.query(`DELETE FROM units      WHERE property_id = $1`, [propId]);
  await client.query(`DELETE FROM unit_types WHERE property_id = $1`, [propId]);
  await client.query(`DELETE FROM properties WHERE id          = $1`, [propId]);
}

// ---------------------------------------------------------------------------
// Insertion helpers
// ---------------------------------------------------------------------------

async function insertProperty(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO properties (name, address, city, state, zip_code, status)
     VALUES ($1, '123 Main St', 'Denver', 'CO', '80206', 'active')
     RETURNING id`,
    [PROPERTY_NAME],
  );
  return rows[0].id;
}

async function insertUnitType(client: PoolClient, propertyId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO unit_types (property_id, name, bedrooms, bathrooms, square_footage)
     VALUES ($1, '1BR/1BA', 1, 1.0, 700)
     RETURNING id`,
    [propertyId],
  );
  return rows[0].id;
}

/** Inserts units 101–120. Returns unit_number → UUID map. */
async function insertUnits(
  client: PoolClient,
  propertyId: string,
  unitTypeId: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  for (let n = 1; n <= 20; n++) {
    const unitNumber = String(100 + n);
    const floor      = Math.floor((n - 1) / 10) + 1;
    // Units 101–115 will be occupied; 116–120 are vacant (available).
    const status     = n <= 15 ? 'occupied' : 'available';

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO units (property_id, unit_type_id, unit_number, floor, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [propertyId, unitTypeId, unitNumber, floor, status],
    );
    map.set(unitNumber, rows[0].id);
  }

  return map;
}

/**
 * Inserts one pricing row per unit.
 * Market rents are taken from the resident definitions; vacant units get the default $1,600.
 */
async function insertUnitPricing(
  client: PoolClient,
  unitMap: Map<string, string>,
): Promise<void> {
  const marketRentByUnit = new Map(RESIDENTS.map((r) => [r.unitNumber, r.marketRent]));
  const today = toDateStr(new Date());

  for (const [unitNumber, unitId] of unitMap) {
    const marketRent = marketRentByUnit.get(unitNumber) ?? 1600;
    await client.query(
      `INSERT INTO unit_pricing (unit_id, base_rent, market_rent, effective_date)
       VALUES ($1, $2, $3, $4)`,
      [unitId, 1600, marketRent, today],
    );
  }
}

/**
 * Inserts all residents, leases, payment ledger entries, and renewal offers.
 *
 * Payment dates are spread evenly over the past 6 months (one per 30 days).
 * paymentCount=6 means no missed payments; paymentCount=3 means 3 missed.
 */
async function insertResidents(
  client: PoolClient,
  propertyId: string,
  unitMap: Map<string, string>,
): Promise<void> {
  const today = new Date();

  for (const def of RESIDENTS) {
    const unitId = unitMap.get(def.unitNumber);
    if (!unitId) throw new Error(`Unit ${def.unitNumber} not found in unitMap`);

    // Resident
    const { rows: [resident] } = await client.query<{ id: string }>(
      `INSERT INTO residents
         (property_id, unit_id, first_name, last_name, email, status, move_in_date)
       VALUES ($1, $2, $3, $4, $5, 'active', $6)
       RETURNING id`,
      [
        propertyId, unitId,
        def.firstName, def.lastName, def.email,
        toDateStr(addDays(today, -(365 + Math.abs(def.daysToExpiry)))),
      ],
    );
    const residentId = resident.id;

    // Lease
    const leaseEnd   = addDays(today, def.daysToExpiry);
    const leaseStart = addDays(leaseEnd, -365);

    const { rows: [lease] } = await client.query<{ id: string }>(
      `INSERT INTO leases
         (property_id, resident_id, unit_id,
          lease_start_date, lease_end_date, monthly_rent, lease_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
       RETURNING id`,
      [
        propertyId, residentId, unitId,
        toDateStr(leaseStart), toDateStr(leaseEnd),
        def.monthlyRent, def.leaseType,
      ],
    );
    const leaseId = lease.id;

    // Payment history
    // Payments at today, today-30d, today-60d … (paymentCount entries).
    // All fall within the 6-month window when asOfDate = today.
    if (def.paymentCount > 0) {
      const vals: unknown[] = [];
      const ph:   string[]  = [];
      let idx = 1;

      for (let i = 0; i < def.paymentCount; i++) {
        const payDate = toDateStr(addDays(today, -(i * 30)));
        vals.push(propertyId, residentId, def.monthlyRent, payDate);
        ph.push(`($${idx}, $${idx + 1}, 'payment', 'rent', $${idx + 2}, $${idx + 3})`);
        idx += 4;
      }

      await client.query(
        `INSERT INTO resident_ledger
           (property_id, resident_id, transaction_type, charge_code, amount, transaction_date)
         VALUES ${ph.join(', ')}`,
        vals,
      );
    }

    // Renewal offer (for residents whose risk is being managed)
    if (def.hasOffer) {
      await client.query(
        `INSERT INTO renewal_offers
           (property_id, resident_id, lease_id,
            renewal_start_date, renewal_end_date, proposed_rent, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
        [
          propertyId, residentId, leaseId,
          toDateStr(leaseEnd),
          toDateStr(addDays(leaseEnd, 365)),
          def.monthlyRent + 50,
        ],
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function seed(): Promise<void> {
  console.log('Seeding database…\n');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await resetSeedData(client);

    const propId     = await insertProperty(client);
    const unitTypeId = await insertUnitType(client, propId);
    const unitMap    = await insertUnits(client, propId, unitTypeId);
    await insertUnitPricing(client, unitMap);
    await insertResidents(client, propId, unitMap);

    await client.query('COMMIT');

    const today = new Date().toISOString().slice(0, 10);

    console.log('✓ Seed data inserted successfully!\n');
    console.log(`  Property ID : ${propId}`);
    console.log(`  Residents   : ${RESIDENTS.length} (15 occupied units, 5 vacant)`);
    console.log(`  Today's date: ${today}\n`);
    console.log('  Expected results for /calculate with asOfDate=' + today + ':');
    console.log('    HIGH   (4): Carol(100), Henry(85), David(75), Jane(65)');
    console.log('    MEDIUM (4): John(63), Bob(55), Emma(50), Frank(45)');
    console.log('    LOW    (7): Alice, Karen, Grace, Liam, Iris, James, Mia');
    console.log('    flaggedCount = 8 / 15\n');
    console.log('  Run the risk calculation:');
    console.log(`  curl -s -X POST http://localhost:3000/api/v1/properties/${propId}/renewal-risk/calculate \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"asOfDate":"${today}"}'\n`);
    console.log('  Read the latest scores:');
    console.log(`  curl -s http://localhost:3000/api/v1/properties/${propId}/renewal-risk`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err: unknown) => {
  console.error('\nSeed failed:', err);
  process.exit(1);
});
