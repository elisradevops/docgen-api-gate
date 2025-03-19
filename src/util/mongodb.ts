import mongoose from 'mongoose';
import logger from './logger';

// When running in Docker, use the service name instead of localhost
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://root:example@mongodb:27017/docgen?authSource=admin';

const connectToDatabase = async (): Promise<void> => {
  try {
    // Add connection options to fix deprecation warnings
    const options = {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      useCreateIndex: true,
      useFindAndModify: false,
    };

    await mongoose.connect(MONGODB_URI, options);
    logger.info('Connected to MongoDB successfully');
  } catch (error) {
    logger.error(`MongoDB connection error: ${error.message}`);
  }
};

export default connectToDatabase;
