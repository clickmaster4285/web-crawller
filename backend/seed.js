/**
 * Seed — ensures the demo admin user exists so the frontend login works
 * against the real API (admin@clickmasters.com / 1234).
 *
 * Idempotent: only creates the user when the email is not present.
 */
const bcrypt = require('bcryptjs');
const User = require('./models/User');

const DEMO_USER = {
  name: 'Admin',
  email: 'admin@clickmasters.com',
  password: '1234',
  role: 'admin',
  isActive: true,
};

async function ensureDemoUser() {
  try {
    const existing = await User.findOne({ email: DEMO_USER.email });
    if (existing) {
      console.log('✅ Demo user already exists — skipping seed');
      return existing;
    }
    const hashedPassword = await bcrypt.hash(DEMO_USER.password, 10);
    const user = await User.create({
      name: DEMO_USER.name,
      email: DEMO_USER.email,
      password: hashedPassword,
      role: DEMO_USER.role,
      isActive: DEMO_USER.isActive,
    });
    console.log(`✅ Seeded demo user: ${DEMO_USER.email} / ${DEMO_USER.password}`);
    return user;
  } catch (error) {
    console.error('Seed error:', error);
    throw error;
  }
}

module.exports = { ensureDemoUser, DEMO_USER };
