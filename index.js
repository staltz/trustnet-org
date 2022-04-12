const {TrustNet} = require('trustnet');
const core = require('@actions/core');
const github = require('@actions/github');
const libHumanTime = require('human-time');

function humanTime(date) {
  if (date === 0) return 'never';
  else return libHumanTime(date);
}

class Approvals {
  constructor() {
    this._map = new Map();
  }

  calcWeight(date) {
    const yearsAgo = Math.floor((Date.now() - date) / (60e3 * 60 * 24 * 365));
    return 1 / 2 ** yearsAgo;
  }

  update(src, dst, date) {
    if (this._map.has(src)) {
      const map = this._map.get(src);
      const prev = map.get(dst) || 0;
      map.set(dst, prev + this.calcWeight(date));
    } else {
      this._map.set(src, new Map([[dst, this.calcWeight(date)]]));
    }
  }

  forEach(cb) {
    this._map.forEach((map, src) => {
      map.forEach((weight, dst) => {
        cb(src, dst, weight);
      });
    });
  }
}

class LastActiveRegistry {
  constructor() {
    this._map = new Map();
  }

  update(id, date) {
    if (this._map.has(id)) {
      const prev = this._map.get(id);
      if (date > prev) this._map.set(id, date);
    } else {
      this._map.set(id, date);
    }
  }

  get(id) {
    return this._map.get(id);
  }
}

async function forEachSourceRepo(octokit, org, cb) {
  for await (const response of octokit.paginate.iterator(
    octokit.rest.repos.listForOrg,
    {org, type: 'sources'},
  )) {
    const page = response.data;
    for (const repo of page) {
      cb(repo);
    }
  }
}

async function forEachMember(octokit, org, cb) {
  for await (const response of octokit.paginate.iterator(
    octokit.rest.orgs.listMembers,
    {org},
  )) {
    const page = response.data;
    for (const member of page) {
      cb(member);
    }
  }
}

async function forEachClosedPR(octokit, owner, repo, cb) {
  for await (const response of octokit.paginate.iterator(
    octokit.rest.pulls.list,
    {owner, repo, state: 'closed'},
  )) {
    const page = response.data;
    for (const _pr of page) {
      const {data: pr} = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: _pr.number,
      });
      await cb(pr);
    }
  }
}

async function forEachApprovedReview(octokit, owner, repo, pull_number, cb) {
  for await (const response of octokit.paginate.iterator(
    octokit.rest.pulls.listReviews,
    {owner, repo, pull_number},
  )) {
    const page = response.data;
    for (const review of page) {
      if (review.state === 'APPROVED') {
        cb(review);
      }
    }
  }
}

async function run() {
  try {
    const token = core.getInput('token');
    const org = core.getInput('org');
    const pioneer = core.getInput('pioneer');
    const blocklist = core.getMultilineInput('blocklist').map((s) => s.trim());
    const trustThreshold = parseInt(core.getInput('trustThreshold'), 10);
    const minMemberCount = parseInt(core.getInput('minMemberCount'), 10);
    const inactiveAfter = Math.max(
      1,
      parseInt(core.getInput('inactiveAfter'), 10),
    );
    const octokit = github.getOctokit(token);

    const tooLongAgo = new Date();
    tooLongAgo.setMonth(tooLongAgo.getMonth() - inactiveAfter);

    const trustnet = new TrustNet();
    const repos = new Set();
    const members = new Set(); // username
    const approvals = new Approvals();
    const lastActiveRegistry = new LastActiveRegistry();

    console.log('Repos:');
    await forEachSourceRepo(octokit, org, (repo) => {
      console.log(repo.name);
      repos.add(repo.name);
    });
    console.log('\n');

    console.log('Members:');
    await forEachMember(octokit, org, (member) => {
      console.log(member.login);
      members.add(member.login);
      lastActiveRegistry.update(member.login, 0);
    });
    console.log('\n');

    for (const repo of [...repos.values()].slice(0, 1)) {
      let prsProcessed = 0;
      await forEachClosedPR(octokit, org, repo, async (pr) => {
        prsProcessed += 1;
        if (pr.created_at) {
          lastActiveRegistry.update(pr.user.login, new Date(pr.created_at));
        }
        if (!pr.merged_at) return;
        if (pr.merged_by && pr.merged_by.id !== pr.user.id) {
          // console.log(
          //   `PR #${pr.number} by ${pr.user.login} ` +
          //     `merged by ${pr.merged_by.login}`,
          // );
          const src = pr.merged_by.login;
          const dst = pr.user.login;
          const date = new Date(pr.merged_at);
          approvals.update(src, dst, date);
          lastActiveRegistry.update(src, date);
        }
        await forEachApprovedReview(octokit, org, repo, pr.number, (review) => {
          // console.log(
          //   `PR #${pr.number} by ${pr.user.login} ` +
          //     `approved by ${review.user.login} ` +
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
              return;
            }
            const date = new Date(review.submitted_at);
            approvals.update(src, dst, date);
            lastActiveRegistry.update(src, date);
          }
        });
      });
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
      const trusted = new Set(trustnet.getAllTrusted());
      console.log('trusted:', [...trusted.values()]);
      const rankings = trustnet.getRankings();
      const sorted = Object.entries(rankings).sort((a, b) => b[1] - a[1]);
      sorted.unshift([pioneer, Infinity]);
      for (const member of members) {
        if (!trusted.has(member)) sorted.push([member, 0]);
      }
      const persons = sorted
        .filter(([username]) => !blocklist.includes(username))
        .map(([username, trust]) => ({
          username,
          trust,
          isMember: members.has(username),
          lastActive: lastActiveRegistry.get(username),
        }));

      for (const person of persons) {
        console.log(
          person.username,
          person.trust,
          humanTime(person.lastActive),
          person.isMember ? 'MEMBER' : '',
        );
      }
      console.log('\n');

      let actions = 0;
      const wouldBeMembers = new Set(...members.values());
      // Add members
      for (const person of persons) {
        if (
          !person.isMember &&
          person.trust >= trustThreshold &&
          person.lastActive > tooLongAgo
        ) {
          core.notice(
            `${person.username} should be made a member ` +
              `(trustnet ${person.trust.toFixed(1)} >= ${trustThreshold} ` +
              `and last active ${humanTime(person.lastActive)})`,
            {title: 'Add member'},
          );
          wouldBeMembers.add(person.username);
          actions += 1;
        }
      }

      // Remove members
      for (const person of persons.reverse()) {
        if (!person.isMember) continue;
        if (wouldBeMembers.size <= minMemberCount) continue;
        if (person.lastActive < tooLongAgo) {
          core.notice(
            `${person.username} should be removed ` +
              `(last active ${humanTime(person.lastActive)})`,
            {title: 'Remove member'},
          );
          wouldBeMembers.delete(person.username);
          actions += 1;
        } else if (person.trust < trustThreshold) {
          core.notice(
            `${person.username} should be removed ` +
              `(trustnet ${person.trust.toFixed(1)} < ${trustThreshold})`,
            {title: 'Remove member'},
          );
          wouldBeMembers.delete(person.username);
          actions += 1;
        }
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
