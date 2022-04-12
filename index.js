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
    const blocklist = core.getMultilineInput('blocklist').map((s) => s.trim());
    const threshold = parseInt(core.getInput('threshold'), 10);
    const octokit = github.getOctokit(token);

    const trustnet = new TrustNet();
    const repoNames = new Set();
    const members = new Set(); // username
    const approvals = {
      _map: new Map(),
      calcWeight(date) {
        const ago = humanTime(date);
        const yearsAgo = ago.includes('year')
          ? parseInt(ago.split('year')[0].trim(), 10)
          : 0;
        return 1 / 2 ** yearsAgo;
      },
      update(src, dst, date) {
        if (this._map.has(src)) {
          const map = this._map.get(src);
          const prev = map.get(dst) || 0;
          map.set(dst, prev + this.calcWeight(date));
        } else {
          this._map.set(src, new Map([[dst, this.calcWeight(date)]]));
        }
      },
      forEach(cb) {
        this._map.forEach((map, src) => {
          map.forEach((weight, dst) => {
            cb(src, dst, weight);
          });
        });
      },
    };
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

    for (const repo of [...repoNames.values()].slice(0, 1)) {
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
            const date = new Date(pr.merged_at);
            approvals.update(src, dst, date);
            lastActive.update(src, date);
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
                  if (!review.submitted_at) {
                    console.warn('review missing submitted_at:', review);
                    continue;
                  }
                  const date = new Date(review.submitted_at);
                  approvals.update(src, dst, date);
                  lastActive.update(src, date);
                }
              }
            }
          }
        }
      }
      console.log(`PRs in ${repo}: ${prsProcessed}`);
    }
    console.log('\n');

    console.log('Approvals:');
    const trustAssignments = [];
    approvals.forEach((src, dst, weight) => {
      console.log(src, dst, weight);
      trustAssignments.push({src, dst, weight});
    });
    console.log('\n');

    console.log('Trustnet:');
    trustnet.load(pioneer, trustAssignments, []).then(() => {
      const rankings = trustnet.getRankings();
      const sorted = Object.entries(rankings).sort((a, b) => b[1] - a[1]);
      let actions = 0;
      const wouldBeMembers = new Set(...members.values())
      for (const [login, score] of sorted) {
        if (blocklist.includes(login)) continue;
        const isMember = members.has(login);
        const lastActiveDate = lastActive.get(login);
        const ago = humanTime(lastActiveDate);
        const action =
          isMember && (ago.includes('year') || score < threshold)
            ? 'TO-REMOVE'
            : !isMember && score >= threshold && !ago.includes('year')
            ? 'TO-ADD'
            : '';
        if (isMember && ago.includes('year')) {
          core.notice(
            `${login} should be removed (last active ${ago})`,
            {title: 'Remove member'},
          );
          actions += 1;
        } else if (isMember && score < threshold) {
          core.notice(
            `${login} should be removed (trustnet ${score.toFixed(1)} < ${threshold})`,
            {title: 'Remove member'},
          );
          actions += 1;
        } else if (!isMember && score >= threshold && !ago.includes('year')) {
          core.notice(
            `${login} should be made a member (trustnet ${score.toFixed(1)} >= ${threshold} and last active ${ago})`,
            {title: 'Add member'},
          );
          actions += 1;
        }

        console.log(
          login,
          score,
          humanTime(lastActiveDate),
          isMember ? 'MEMBER' : '',
          action,
        );
      }

      if (actions > 0) {
        core.setFailed(`${actions} actions need to be done`);
      }
    });
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
