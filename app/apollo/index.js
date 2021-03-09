/**
 * Copyright 2020 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const http = require('http');
const express = require('express');
const router = express.Router();
const ebl = require('express-bunyan-logger');
const bunyan = require('bunyan');
const { ApolloServer } = require('apollo-server-express');
const addRequestId = require('express-request-id')();
const { IdentifierDirective, JsonDirective } = require('./utils/directives');
const { getBunyanConfig } = require('./utils/bunyan');
const { AUTH_MODEL, GRAPHQL_PATH } = require('./models/const');
const typeDefs = require('./schema');
const resolvers = require('./resolvers');
const recoveryHintsMap = require('./resolvers/recoveryHintsMap');
const { models, connectDb } = require('./models');
const bunyanConfig = getBunyanConfig('apollo');
const logger = bunyan.createLogger(bunyanConfig);
const promClient = require('prom-client');
const createMetricsPlugin = require('apollo-metrics');
const apolloMetricsPlugin = createMetricsPlugin(promClient.register);
const { GraphqlPubSub } = require('./subscription');
const initModule = require(`./init.${AUTH_MODEL}`);

const pubSub = GraphqlPubSub.getInstance();

const i18next = require('i18next');
const i18nextMiddleware = require('i18next-http-middleware');
const i18nextBackend = require('i18next-fs-backend');
i18next.use(i18nextBackend).use(i18nextMiddleware.LanguageDetector).init({
  //debug: true,
  backend: {
    loadPath: './locales/{{lng}}/razee-resources.json'
  },
  fallbackLng: 'en',
  supportedLngs:['en', 'de', 'es', 'fr', 'it', 'ja', 'ko', 'pt-br', 'zh-cn', 'zh-tw'],
  load: 'languageOnly',
  saveMissing: false,
  initImmediate: true,
  nsSeparator: '#||#',
  keySeparator: '#|#'
});

const createDefaultApp = () => {
  const app = express();
  app.set('trust proxy', true);
  app.use(addRequestId);
  app.use(function errorHandler(err, req, res, next) {
    if (err) {
      if (req.log && req.log.error) req.log.error(err);
      else logger.error(err);
      if (!res.headersSent) {
        const statusCode = err.statusCode || 500;
        return res.status(statusCode).send();
      }
      return next(err);
    }
    return next();
  });
  app.use(i18nextMiddleware.handle(i18next));
  return app;
};

const buildCommonApolloContext = async ({ models, req, res, connection, logger }) => {
  let context = await initModule.buildApolloContext({
    models,
    req,
    res,
    connection,
    logger,
  });
  // populate req and req_id to apollo context
  if (connection) {
    const upgradeReq = connection.context.upgradeReq;
    const apiKey = connection.context.orgKey;
    const userToken = connection.context.userToken;
    const orgId = connection.context.orgId;
    context = { apiKey: apiKey, req: upgradeReq, req_id: upgradeReq ? upgradeReq.id : undefined, userToken, recoveryHintsMap, orgId, ...context };
  } else if (req) {
    context = { req, req_id: req.id, recoveryHintsMap, ...context };
  }
  return context;
};

const loadCustomPlugins =  () => {
  if (process.env.GRAPHQL_CUSTOM_PLUGINS) {
    try {
      const pluginStrs = process.env.GRAPHQL_CUSTOM_PLUGINS.split(';');
      return pluginStrs.map( str => {
        logger.info('Loading custom plugin: ' + str);
        return require(str);
      });
    } catch (err) {
      logger.error(err, 'Error encountered when loading custom plugin.');
      process.exit(1);
    }
  }
  return [];
};

var SIGTERM = false;
process.on('SIGTERM', () => SIGTERM = true);

const createApolloServer = () => {
  const customPlugins = loadCustomPlugins();
  if (process.env.GRAPHQL_ENABLE_TRACING === 'true') {
    logger.info('Adding metrics plugin: apollo-metrics');
    customPlugins.push(apolloMetricsPlugin);
  }
  logger.info(customPlugins, 'Apollo server custom plugin are loaded.');
  const server = new ApolloServer({
    introspection: true, // set to true as long as user has valid token
    plugins: customPlugins,
    tracing: process.env.GRAPHQL_ENABLE_TRACING === 'true',
    playground: process.env.GRAPHQL_ENABLE_PLAYGROUND === 'false',
    typeDefs,
    resolvers,
    schemaDirectives: {
      sv: IdentifierDirective,
      jv: JsonDirective,
    },
    formatError: error => {
      // remove the internal sequelize error message
      // leave only the important validation error
      const message = error.message
        .replace('SequelizeValidationError: ', '')
        .replace('Validation error: ', '');
      return {
        ...error,
        message,
      };
    },
    context: async ({ req, res, connection }) => {
      return buildCommonApolloContext({
        models,
        req,
        res,
        connection,
        logger,
      });
    },
    subscriptions: {
      path: GRAPHQL_PATH,
      keepAlive: 10000,
      onConnect: async (connectionParams, webSocket, context) => {
        const req_id = webSocket.upgradeReq.id;

        let orgKey, orgId;
        if(connectionParams.headers && connectionParams.headers['razee-org-key']) {
          orgKey = connectionParams.headers['razee-org-key'];
          const org = await models.Organization.findOne({ orgKeys: orgKey });
          orgId = org._id;
        }

        logger.trace({ req_id, connectionParams, context }, 'subscriptions:onConnect');
        const me = await models.User.getMeFromConnectionParams( connectionParams, {req_id, models, logger, ...context},);

        logger.debug({ me }, 'subscriptions:onConnect upgradeReq getMe');
        if (me === undefined) {
          throw Error(
            'Can not find the session for this subscription request.',
          );
        }

        // add original upgrade request to the context
        return { me, upgradeReq: webSocket.upgradeReq, logger, orgKey, orgId };
      },
      onDisconnect: (webSocket, context) => {
        logger.debug(
          { req_id: webSocket.upgradeReq.id, headers: context.request.headers },
          'subscriptions:onDisconnect upgradeReq getMe',
        );
      },
    },
    onHealthCheck: async() => {
      if(SIGTERM){
        throw 'SIGTERM received. Not accepting additional requests';
      }else {
        return 200;
      }
    }
  });
  return server;
};

const stop = async (apollo) => {
  await apollo.db.connection.close();
  await apollo.server.stop();
  await apollo.httpServer.close(() => {
    console.log('🏄 Apollo Server closed.');
  });
};

const apollo = async (options = {}) => {

  try {
    const db = await connectDb(options.mongo_url);
    const app = options.app ? options.app : createDefaultApp();
    router.use(ebl(getBunyanConfig('apollo')));
    if (initModule.playgroundAuth && process.env.GRAPHQL_ENABLE_PLAYGROUND === 'true') {
      logger.info('Enabled playground route with authorization enforcement.');
      app.get(GRAPHQL_PATH, initModule.playgroundAuth);
    }
    app.use(GRAPHQL_PATH, router);
    initModule.initApp(app, models, logger);

    const server = createApolloServer();
    server.applyMiddleware({
      app,
      path: GRAPHQL_PATH,
      onHealthCheck: () => {
        return new Promise((resolve, reject) => {
          if (pubSub.enabled) {
            resolve();
          } else {
            reject();
          }
        });
      }
    });

    const httpServer = options.httpServer ? options.httpServer : http.createServer(app);
    server.installSubscriptionHandlers(httpServer);
    httpServer.on('listening', () => {
      const addrHost = httpServer.address().address;
      const addrPort = httpServer.address().port;
      logger.info(
        `🏄 Apollo server listening on http://[${addrHost}]:${addrPort}${GRAPHQL_PATH}`,
      );
    });

    if (!options.httpServer) {
      let port = process.env.GRAPHQL_PORT || 8000;
      if (options.graphql_port !== undefined) {
        port = options.graphql_port;
      }
      httpServer.listen({ port });
    }
    return { db, server, httpServer, stop};
  } catch (err) {
    logger.error(err, 'Apollo api error');
    process.exit(1);
  }
};

module.exports = apollo;
