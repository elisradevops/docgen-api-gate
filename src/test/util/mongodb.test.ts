import mongoose from 'mongoose';
import connectToDatabase from '../../util/mongodb';
import logger from '../../util/logger';

jest.mock('mongoose', () => {
  const connect = jest.fn();
  return { __esModule: true, default: { connect }, connect } as any;
});

jest.mock('../../util/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
  },
}));

const asMockConnect = () => (mongoose as any).connect as jest.Mock;
const getMockLogger = () => logger as unknown as { info: jest.Mock; error: jest.Mock };

describe('connectToDatabase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.MONGODB_URI;
  });

  test('connects to default URI and logs success', async () => {
    asMockConnect().mockResolvedValueOnce(undefined);

    await connectToDatabase();

    expect(asMockConnect()).toHaveBeenCalledWith(
      'mongodb://root:example@mongodb:27017/docgen?authSource=admin',
      expect.objectContaining({
        useNewUrlParser: true,
        useUnifiedTopology: true,
        useCreateIndex: true,
        useFindAndModify: false,
      })
    );

    expect(getMockLogger().info).toHaveBeenCalledWith('Connected to MongoDB successfully');
  });

  test('logs error when connection fails', async () => {
    asMockConnect().mockRejectedValueOnce(new Error('boom'));

    await connectToDatabase();

    expect(getMockLogger().error).toHaveBeenCalledWith(
      expect.stringContaining('MongoDB connection error: boom')
    );
  });
});
