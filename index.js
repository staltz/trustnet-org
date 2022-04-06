const {TrustNet} = require('trustnet');
const core = require('@actions/core');
const github = require('@actions/github');
const humanTime = require('human-time');

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
    const members = new Set(); // username
    const lastActive = {
      _map: new Map(),
      update(id, date) {
        if (this._map.has(id)) {
          const prev = this._map.get(id);
          if (date > prev) this._map.set(id, date);
        } else {
          this._map.set(id, date);
        }
      },
      get(id) {
        return this._map.get(id);
      },
    };

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
      console.log(member.login);
      members.add(member.login);
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
          prsProcessed += 1;
          if (pr.created_at) {
            lastActive.update(pr.user.login, new Date(pr.created_at));
          }
          if (!pr.merged_at) continue;
          if (pr.merged_by && pr.merged_by.id !== pr.user.id) {
            // console.log(
            //   'PR #' +
            //     pr.number +
            //     ' by ' +
            //     pr.user.login +
            //     ' merged by ' +
            //     pr.merged_by.login,
            // );
            const src = pr.merged_by.login;
            const dst = pr.user.login;
            trustAssignments.push({src, dst, weight: 1.0});
            lastActive.update(src, new Date(pr.merged_at));
          }
          for await (const response of octokit.paginate.iterator(
            octokit.rest.pulls.listReviews,
            {owner: org, repo, pull_number: pr.number},
          )) {
            const page = response.data;
            for (const review of page) {
              if (review.state === 'APPROVED') {
                // console.log(
                //   'PR #' +
                //     pr.number +
                //     ' by ' +
                //     pr.user.login +
                //     ' approved by ' +
                //     review.user.login +
                //     ' ' +
                //     review.author_association,
                // );
                if (
                  !pr.merged_by ||
                  (review.user && review.user.id !== pr.merged_by.id)
                ) {
                  const src = review.user.login;
                  const dst = pr.user.login;
                  trustAssignments.push({src, dst, weight: 1.0});
                  if (review.submitted_at) {
                    lastActive.update(src, new Date(review.submitted_at));
                  }
                }
              }
            }
          }
        }
      }
      console.log(`PRs in ${repo}: ${prsProcessed}`);
    }
    console.log('\n');

    console.log('Trustnet:');
    trustnet.load(pioneer, trustAssignments, []).then(() => {
      const rankings = trustnet.getRankings();
      const sorted = Object.entries(rankings).sort((a, b) => b[1] - a[1]);
      for (const [login, score] of sorted) {
        const isMember = members.has(login);
        const lastActiveDate = lastActive.get(login);
        console.log(
          login,
          score,
          humanTime(lastActiveDate),
          isMember ? 'MEMBER' : '',
        );
      }
    });
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
