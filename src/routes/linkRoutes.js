const express = require('express');
const linkController = require('../controllers/linkController');
const { distributedRateLimiter } = require('../middleware/distributedRateLimiter');

const apiRouter = express.Router();
apiRouter.post('/shorten', distributedRateLimiter(), linkController.shorten);

const redirectRouter = express.Router();
redirectRouter.get('/:code/stats', linkController.stats);
redirectRouter.get('/:code', linkController.redirect);

module.exports = { apiRouter, redirectRouter };
