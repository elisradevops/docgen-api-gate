import request, { SuperTest, Test } from 'supertest';

type Agent = SuperTest<Test>;

export async function withLocalAgent(app: any, fn: (agent: Agent) => any): Promise<any> {
  const server = app.listen(0, '127.0.0.1');

  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', (err: any) => reject(err));
  });

  try {
    const agent = request(server);
    return await fn(agent);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err: any) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }
}
