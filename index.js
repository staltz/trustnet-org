const {TrustNet} = require('trustnet');
const core = require('@actions/core');
const github = require('@actions/github');

async function listForOrg(octokit, options, cb) {
  for await (const response of octokit.paginate.iterator(
    octokit.rest.repos.listForOrg,
    options,
  )) {
    const page = response.data;
    for (const repo of page) {
      cb(repo);
    }
  }
}

async function listMembers(octokit, options, cb) {
  for await (const response of octokit.paginate.iterator(
    octokit.rest.orgs.listMembers,
    options,
  )) {
    const page = response.data;
    for (const member of page) {
      cb(member);
    }
  }
}

async function run() {
  try {
    const token = core.getInput('token');
    const org = core.getInput('org');
    const pioneer = core.getInput('pioneer');
    const octokit = github.getOctokit(token);

    const trustnet = new TrustNet();
    const trustAssignments = [];
    const repoNames = new Set();
    const members = new Map(); // id => login (aka username)

    const {data: pioneerUser} = await octokit.rest.users.getByUsername({
      username: pioneer,
    });
    console.log('Pioneer:', pioneerUser);
    console.log('\n');

    console.log('Repos:');
    await listForOrg(octokit, {org, type: 'sources'}, (repo) => {
      console.log(repo.name);
      repoNames.add(repo.name);
    });
    console.log('\n');

    console.log('Members:');
    await listMembers(octokit, {org}, (member) => {
      console.log('@' + member.login, member.id);
      members.set(member.id, member.login);
    });
    console.log('\n');

    for (const repo of repoNames) {
      let prsProcessed = 0;
      for await (const response of octokit.paginate.iterator(
        octokit.rest.pulls.list,
        {owner: org, repo, state: 'closed'},
      )) {
        const page = response.data;
        for (const _pr of page) {
          const {data: pr} = await octokit.rest.pulls.get({
            owner: org,
            repo,
            pull_number: _pr.number,
          });
          if (pr.merged_at) {
            if (pr.merged_by.id !== pr.user.id) {
              console.log(
                'PR #' +
                  pr.number +
                  ' by ' +
                  pr.user.login +
                  ' merged by ' +
                  pr.merged_by.login,
              );
              trustAssignments.push({
                src: pr.merged_by.login, // FIXME: change to id?
                dst: pr.user.login, // FIXME: change to id?
                weight: 1.0,
              });
            }
            for await (const response of octokit.paginate.iterator(
              octokit.rest.pulls.listReviews,
              {owner: org, repo, pull_number: pr.number},
            )) {
              const page = response.data;
              for (const review of page) {
                if (review.state === 'APPROVED') {
                  console.log(
                    'PR #' +
                      pr.number +
                      ' by ' +
                      pr.user.login +
                      ' approved by ' +
                      review.user.login +
                      ' ' +
                      review.author_association,
                  );
                  if (review.user.id !== pr.merged_by.id) {
                    trustAssignments.push({
                      src: review.user.login, // FIXME: change to id?
                      dst: pr.user.login, // FIXME: change to id?
                      weight: 1.0,
                    });
                  }
                }
              }
            }
          }
        }
      }
      console.log('PRs in ssb-db: ' + prsProcessed);
    }
    console.log('\n');

    console.log('Trustnet:');
    trustnet.load(pioneer, trustAssignments, []).then(() => {
      console.log(trustnet.getRankings());
    });
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
