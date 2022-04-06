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

    const octokit = github.getOctokit(token);

    const repoNames = new Set();
    const members = new Map(); // id => login (aka username)

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

    console.log('PRS to ssb-db:');
    for await (const response of octokit.paginate.iterator(
      octokit.rest.pulls.list,
      {owner: org, repo: 'ssb-db', state: 'closed'},
    )) {
      const page = response.data;
      for (const pr of page) {
        if (pr.merged_at) {
          for await (const response of octokit.paginate.iterator(
            octokit.rest.pulls.listReviews,
            {owner: org, repo: 'ssb-db', pull_number: pr.number},
          )) {
            const page = response.data;
            for (const review of page) {
              const prReviewer = review.user.id;
              if (review.state === 'APPROVED') {
                console.log(
                  'PR #' +
                    pr.number +
                    ' by ' +
                    members.get(pr.user.id) +
                    ' approved by ' +
                    members.get(prReviewer) +
                    ' ' +
                    review.author_association,
                );
              }
            }
          }
        }
      }
      // if (pr.merged_at) {
      //   const mergedBy = members.get(pr.merged_by.id);
      //   console.log('  Merged by:', mergedBy);
      // }
    }

    // for (const repoName of repoNames) {
    //   console.log('Contributors to ' + repoName + ':');
    //   for await (const response of octokit.paginate.iterator(
    //     octokit.rest.repos.listContributors,
    //     {
    //       owner: org,
    //       repo: repoName,
    //     },
    //   )) {
    //     const page = response.data;
    //     for (const item of page) {
    //       console.log(item);
    //     }
    //   }
    //   console.log('\n');

    //   console.log('Collaborators to ' + repoName + ':');
    //   for await (const response of octokit.paginate.iterator(
    //     octokit.rest.repos.listCollaborators,
    //     {
    //       owner: org,
    //       repo: repoName,
    //     },
    //   )) {
    //     const page = response.data;
    //     for (const item of page) {
    //       console.log(item);
    //     }
    //   }
    //   console.log('\n');
    // }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
