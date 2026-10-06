const { installedBundle } = require("../services/bundleContext");

/*
 * After authenticate: the organization's installed profession bundle on
 * req.auth.bundle — { key, capabilities, vocabulary } — or null. Tools that
 * need a capability the bundle does not have are left out of the catalog
 * (toolCatalog.toolsFor), so an organization without a bundle keeps exactly
 * today's assistant. A failed lookup means no bundle: the assistant still
 * works, only the bundle's tools and help are missing.
 */
async function withBundle(req, res, next) {
  try {
    const token = req.headers.authorization.split(" ")[1];
    const bundle = await installedBundle(req.auth.organizationId, token);

    req.auth.bundle = bundle ? { key: bundle.key, capabilities: bundle.capabilities || [], vocabulary: bundle.vocabulary || {} } : null;
  } catch (error) {
    console.error("[Assistant] bundle lookup failed:", error.message);
    req.auth.bundle = null;
  }

  return next();
}

module.exports = withBundle;
