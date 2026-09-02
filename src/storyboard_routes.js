import { STORE, parseSessionId } from './lib/media.js';
import { JOB, streamJob } from './lib/jobs.js';
import { StoryboardApprovals, developStoryboard, storyboardImages, cropStoryboardImage, generateStoryboardClips } from './lib/storyboard.js';

export function mountStoryboard(app, { chatCompletion, approvals = new StoryboardApprovals() } = {}) {
  const route = work => async (req, res) => {
    try {
      if (!req.body?.session_id) throw new Error('A session ID is required.');
      const sessionId = parseSessionId(req.body.session_id);
      await work(req, res, sessionId);
    } catch (error) {
      res.status(['HUMAN_REVIEW_REQUIRED', 'REVIEW_OUTDATED'].includes(error.code) ? 409 : 400).json({ error: { code: error.code || 'INVALID_REQUEST', message: error.message } });
    }
  };
  app.post('/h3studio/storyboard/develop', route(async (req, res) => {
    await streamJob(req, res, context => developStoryboard(req.body, { ...context, chatCompletion }));
  }));
  app.post('/h3studio/storyboard/images', route(async (req, res) => {
    await streamJob(req, res, context => storyboardImages(req.body, { ...context, chatCompletion }));
  }));
  app.post('/h3studio/storyboard/crop', route(async (req, res, sessionId) => {
    await streamJob(req, res, async context => {
      context.progress('cropping', 'Creating a separate panel image. The original stays unchanged.');
      const asset = await cropStoryboardImage({ sessionId, assetId: req.body.asset_id, rect: req.body.rect, store: STORE });
      if (context.signal.aborted) { await STORE.remove(sessionId, asset.id); context.signal.throwIfAborted(); }
      approvals.revoke(sessionId);
      return { asset };
    });
  }));
  app.post('/h3studio/storyboard/approve', route(async (req, res, sessionId) => {
    if (JOB.active_request_id) throw new Error('Wait for the current operation before approving a plan.');
    res.json({ approval: approvals.approve(sessionId, req.body.plan, STORE.assets(sessionId), req.body.reviewed) });
  }));
  app.post('/h3studio/storyboard/revoke', route(async (_req, res, sessionId) => {
    approvals.revoke(sessionId); res.json({ revoked: true });
  }));
  app.post('/h3studio/storyboard/generate', route(async (req, res, sessionId) => {
    const plan = approvals.require(sessionId, req.body.plan, STORE.assets(sessionId), req.body.approval_token);
    await streamJob(req, res, async context => {
      const result = await generateStoryboardClips(req.body, plan, STORE, { ...context, chatCompletion });
      approvals.require(sessionId, req.body.plan, STORE.assets(sessionId), req.body.approval_token);
      return result;
    });
  }));
}
