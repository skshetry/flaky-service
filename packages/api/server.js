
// Copyright 2020 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const express = require('express');
const session = require('express-session');
const Repository = require('./src/repository');
const fetch = require('node-fetch');
const querystring = require('querystring');
const app = express();
const moment = require('moment');
const bodyParser = require('body-parser');
const PostBuildHandler = require('./src/post-build.js');
const GetBuildHandler = require('./src/get-build.js');
const GetRepoOrgsHandler = require('./src/get-repo-orgs.js');
const GetTestHandler = require('./src/get-test.js');
const client = require('./src/firestore.js');
// require('./src/cron.js');

const { FirestoreStore } = require('@google-cloud/connect-firestore');
const { v4 } = require('uuid');

const cors = require('cors');
const cron = require('node-cron');
const isLoggedIn = require('./src/isLoggedIn.js');

// Delete sessions every five minutes
// const task = cron.schedule('* * * * * *', () => {
const task = cron.schedule('*/5 * * * *', () => {
  console.log('CRON');
  const repository = new Repository();
  repository.deleteExpiredSessions();
});

app.use('/protected', (req, res, next) => {
  isLoggedIn.isLoggedIn(req, res, next);
});

global.headCollection = process.env.HEAD_COLLECTION || 'testing-buildsget';

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true })); // support encoded bodies
app.use(
  session({
    store: new FirestoreStore({
      dataset: client,
      kind: 'express-sessions-cp'
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true
  })
);

app.get('/protected/api/repos', async (req, res) => {
  console.log('MADE IT INTO SERVER!');
  const repository = new Repository();
  const result = await repository.getCollection('dummy-repositories');

  const repoNames = [];

  for (let index = 0; index < result.length; index++) {
    const id = result[index].repositoryid;
    repoNames.push(id);
  }

  const jsonObject = { repoNames: repoNames };
  // TODO allow the requester to give search/filter criterion!
  res
    .status(200)
    .send(jsonObject)
    .end();
});

app.get('/api/auth', (req, res) => {
  console.log('AUTH SESSION ID: ' + req.sessionID);
  // res.setHeader('Access-Control-Allow-Credentials', 'true');
  req.session.authState = v4();
  const url = 'http://github.com/login/oauth/authorize?client_id=' + process.env.CLIENT_ID + '&state=' + req.session.authState + '&allow_signup=false';
  // console.log('AUTH URL: ' + url);
  res.status(302).redirect(url);
});

app.get('/api/callback', async (req, res) => {
  console.log('CALLBACK SESSION ID: ' + req.sessionID);
  const redirect = process.env.FRONTEND_URL;
  console.log('/callback receives state: ' + req.param('state') + ' and code: ' + req.param('code'));

  if (req.param('state') !== req.session.authState) {
    console.log('failed first check. authState is: ' + req.session.authState);
    res.status(401).redirect(redirect);
    return;
  }

  console.log('made past first check');

  const resp = await fetch('https://github.com/login/oauth/access_token', {
    method: 'post',
    body: JSON.stringify({
      code: req.param('code'),
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
      state: req.session.authState
    }),
    headers: { 'Content-Type': 'application/json' }
  });

  const respText = await resp.text();
  const queryObject = querystring.parse(respText);

  if (resp.status !== 200) {
    res.status(401).redirect(redirect);
    return;
  }

  const result = await fetch('https://api.github.com/user', {
    method: 'get',
    headers: { 'content-type': 'application/json', 'User-Agent': 'flaky.dev', Authorization: 'token ' + queryObject.access_token }
  });

  const resultJSON = await result.json();

  if (result.status !== 200) {
    res.status(401).redirect(redirect);
    return;
  }

  const repository = new Repository();
  const permitted = await repository.mayAccess('github', resultJSON.login);
  if (permitted) {
    console.log('PERMITTED');
    req.session.user = resultJSON.login; // Only store login in the session if they are an admin
    req.session.expires = moment().add(4, 'hours').format();
  } else {
    repository.deleteDoc('express-sessions/' + req.sessionID);
  }
  // await repository.storeSessionPermission(req.sessionID, permitted);
  res.status(200).redirect(redirect);
});

app.get('/protected/api/session', async (req, res) => {
  const repository = new Repository();
  const result = await repository.sessionPermissions(req.sessionID);
  res.status(200).send(result);
});

const postBuildHandler = new PostBuildHandler(app, client);
postBuildHandler.listen();
const getBuildHandler = new GetBuildHandler(app, client);
getBuildHandler.listen();
const getRepoOrgsHandler = new GetRepoOrgsHandler(app, client);
getRepoOrgsHandler.listen();
const getTestHandler = new GetTestHandler(app, client);
getTestHandler.listen();

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
const host = '0.0.0.0';
const server = app.listen(port, host, () => console.log(`Example app listening at http://localhost:${port}`));

module.exports = {
  close: () => {
    console.log('Closing Server: ' + port);
    task.stop();
    server.close();
  },
  server: server
};
