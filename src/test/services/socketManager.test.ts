import { eventEmmiter } from '../../services/socketManager';

describe('socketManager eventEmmiter', () => {
  test('emits event via io.emit', async () => {
    const io = { emit: jest.fn() };
    const data = { foo: 'bar' };

    await eventEmmiter(io as any, 'test-event', data);

    expect(io.emit).toHaveBeenCalledWith('test-event', data);
  });

  test('logs error when io.emit throws', async () => {
    const error = new Error('boom');
    const io = {
      emit: jest.fn(() => {
        throw error;
      }),
    };
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await eventEmmiter(io as any, 'test-event', {});

    expect(consoleErrorSpy).toHaveBeenCalledWith(error);

    consoleErrorSpy.mockRestore();
  });
});
