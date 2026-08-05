const mongoose = require('mongoose');


const connectDatabase = async () => {
  try {
    const mongoURI = process.env.MONGODB_URI;
    if (!mongoURI) {
      throw new Error(
        'MONGODB_URI is not set. Create a backend/.env file (see backend/.env.example).'
      );
    }
    // Note: useNewUrlParser/useUnifiedTopology were removed — they are
    // deprecated and ignored since the MongoDB driver v4 (Mongoose 6+).
    const conn = await mongoose.connect(mongoURI);
    console.log(`🍃 MongoDB Connected: ${conn.connection.host}`);
    return conn;
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
};

mongoose.connection.on('disconnected', () => {
  console.warn('MongoDB disconnected');
});

mongoose.connection.on('error', (error) => {
  console.error('MongoDB error:', error);
});

module.exports = { connectDatabase };
