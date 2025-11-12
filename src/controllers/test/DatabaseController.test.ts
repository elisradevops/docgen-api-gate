import { buildRes } from '../../test/utils/testResponse';
jest.mock('mongoose', () => {
  const findOne = jest.fn();
  const find = jest.fn();
  const findOneAndDelete = jest.fn();
  const FavoriteCtor: any = function(this: any, doc: any) {
    Object.assign(this, doc);
    this.save = jest.fn().mockResolvedValue(this);
  };
  FavoriteCtor.findOne = findOne;
  FavoriteCtor.find = find;
  FavoriteCtor.findOneAndDelete = findOneAndDelete;

  class MockSchema {
    static Types = { Mixed: 'mixed' };
    index = jest.fn();
    constructor(_: any) {}
  }
  return {
    __esModule: true,
    default: { model: jest.fn(() => FavoriteCtor) },
    model: jest.fn(() => FavoriteCtor),
    Schema: MockSchema,
    _FavoriteCtor: FavoriteCtor,
  } as any;
});

jest.mock('../../helpers/openTracing/tracer-middleware', () => ({
  createControllerSpan: jest.fn(() => ({})),
  finishSpanWithResult: jest.fn(),
}));

jest.mock('../../util/logger', () => ({ error: jest.fn(), debug: jest.fn() }));

describe('DatabaseController', () => {
  const { DatabaseController } = require('../DatabaseController');
  let controller: typeof DatabaseController.prototype;
  let mongooseMod: any;
  beforeEach(() => {
    jest.clearAllMocks();
    controller = new DatabaseController();
    mongooseMod = require('mongoose');
  });

  /**
   * createFavorite (missing fields)
   * Returns 400 when required body fields are missing.
   */
  test('createFavorite: 400 on missing fields', async () => {
    const req: any = { body: { userId: 'u1', name: '', docType: '', teamProjectId: '' } };
    const res = buildRes();
    await controller.createFavorite(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  /**
   * createFavorite (update existing)
   * If a favorite exists for user+docType+teamProject+name, updates its data and returns 200.
   */
  test('createFavorite: updates existing favorite', async () => {
    const req: any = { body: { userId: 'u1', name: 'n1', docType: 'STD', dataToSave: { a: 1 }, teamProjectId: 'tp', isShared: false } };
    const res = buildRes();

    const Favorite = mongooseMod._FavoriteCtor;
    const existing = new Favorite({ id: 'f1', userId: 'u1', name: 'n1', docType: 'STD', dataToSave: { a: 0 }, teamProjectId: 'tp' });
    Favorite.findOne.mockResolvedValueOnce(existing);

    await controller.createFavorite(req, res);

    expect(existing.save).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  /**
   * createFavorite (create new)
   * Creates a new favorite when one does not already exist, returns 201 and favorite payload.
   */
  test('createFavorite: creates new favorite when not exists', async () => {
    const req: any = { body: { userId: 'u1', name: 'n1', docType: 'STD', dataToSave: { a: 1 }, teamProjectId: 'tp' } };
    const res = buildRes();

    const Favorite = mongooseMod._FavoriteCtor;
    Favorite.findOne.mockResolvedValueOnce(null);

    await controller.createFavorite(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.body?.favorite).toBeDefined();
  });

  /**
   * getFavorites (missing query)
   * Returns 400 when required query parameters are missing.
   */
  test('getFavorites: 400 on missing query params', async () => {
    const req: any = { query: {} };
    const res = buildRes();
    await controller.getFavorites(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  /**
   * getFavorites (success)
   * Returns 200 with a list of favorites filtered by userId+docType+teamProjectId.
   */
  test('getFavorites: returns favorites list', async () => {
    const req: any = { query: { userId: 'u1', docType: 'STD', teamProjectId: 'tp' } };
    const res = buildRes();
    const Favorite = mongooseMod._FavoriteCtor;
    Favorite.find.mockResolvedValueOnce([{ id: '1' }]);

    await controller.getFavorites(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toEqual({ favorites: [{ id: '1' }] });
  });

  /**
   * deleteFavorite (missing id)
   * Returns 400 when the id path parameter is missing.
   */
  test('deleteFavorite: 400 on missing id', async () => {
    const req: any = { params: {} };
    const res = buildRes();
    await controller.deleteFavorite(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  /**
   * deleteFavorite (not found)
   * Returns 404 when no favorite document is found by id.
   */
  test('deleteFavorite: 404 when not found', async () => {
    const req: any = { params: { id: 'nope' } };
    const res = buildRes();
    const Favorite = mongooseMod._FavoriteCtor;
    Favorite.findOneAndDelete.mockResolvedValueOnce(null);

    await controller.deleteFavorite(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  /**
   * deleteFavorite (success)
   * Returns 200 when a favorite is successfully deleted.
   */
  test('deleteFavorite: 200 on success', async () => {
    const req: any = { params: { id: 'ok' } };
    const res = buildRes();
    const Favorite = mongooseMod._FavoriteCtor;
    Favorite.findOneAndDelete.mockResolvedValueOnce({ id: 'ok' });

    await controller.deleteFavorite(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });
});
