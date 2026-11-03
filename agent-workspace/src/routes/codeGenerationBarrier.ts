import type { RequestHandler } from 'express';
let activeWrites = 0;
/** Track requests until their operation finishes, not client disconnect. A lost
 * finish remains fail-closed until operator restart. Import is synchronous, so
 * no new JS request can start between this check and the final rename. */
export const trackWorkspaceWrites: RequestHandler = (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || /^\/code-generation(?:\/(?:recovery-preview|recover))?\/?$/.test(req.path)) { next(); return; }
  activeWrites++;
  res.once('finish', () => { activeWrites--; });
  next();
};
export function assertCodegenImportIdle(): void {
  if (activeWrites) throw Error('codegen_workspace_busy');
}
