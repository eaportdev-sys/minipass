// Startup only. Routes, authentication, records and workflows are separate modules.
const context = require('./context')();
require('./network')(context);
