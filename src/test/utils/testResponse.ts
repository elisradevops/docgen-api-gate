export type MockRes = ReturnType<typeof buildRes>;
export function buildRes() {
  const res: any = {};
  res.statusCode = 200;
  res.body = undefined;
  res.text = undefined;
  res.cookies = {} as Record<string, { value: string; options: any }>;
  res.clearedCookies = [] as string[];
  res.redirectedTo = undefined as string | undefined;
  res.headers = {} as Record<string, string>;
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((body: any) => {
    res.body = body;
    return res;
  });
  // Chainable stand-ins for the auth flow's cookie/redirect/raw-HTML
  // response methods — additive to the existing status/json pair so
  // pre-existing controller tests using only those are unaffected.
  res.cookie = jest.fn((name: string, value: string, options: any) => {
    res.cookies[name] = { value, options };
    return res;
  });
  res.clearCookie = jest.fn((name: string, _options?: any) => {
    res.clearedCookies.push(name);
    return res;
  });
  res.redirect = jest.fn((url: string) => {
    res.redirectedTo = url;
    return res;
  });
  res.set = jest.fn((headers: Record<string, string>) => {
    Object.assign(res.headers, headers);
    return res;
  });
  res.send = jest.fn((body: any) => {
    res.text = body;
    return res;
  });
  return res;
}
