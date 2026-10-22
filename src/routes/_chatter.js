'use strict';
const auditsvc = require('../services/auditsvc');

/** Data panel ⑤ Related Docs · Log Notes · Audit / History untuk satu dokumen. */
async function loadChatter(docType, docId, { numbers = [], related = [] } = {}) {
  const [messages, logs] = await Promise.all([
    auditsvc.messagesFor(docType, docId),
    auditsvc.logsFor(docType, docId, numbers),
  ]);
  return { docType, docId, related, messages, logs: logs.reverse() };
}

module.exports = { loadChatter };
