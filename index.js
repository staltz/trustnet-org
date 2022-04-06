const core = require('@actions/core');
const github = require('@actions/github');

async function run() {
  try {
    const token = core.getInput('token');
    const org = core.getInput('org');

    const octokit = github.getOctokit(token);

    const repoNames = new Set();
    const members = new Map(); // id => login (aka username)

    console.log('Repos:');
    for await (const response of octokit.paginate.iterator(
      octokit.rest.repos.listForOrg,
      {org, type: 'sources'},
    )) {
      const page = response.data;
      for (const repo of page) {
        console.log(repo.name);
        repoNames.add(repo.name);
      }
    }
    console.log('\n');

    console.log('Members:');
    for await (const response of octokit.paginate.iterator(
      octokit.rest.orgs.listMembers,
      {org},
    )) {
      const page = response.data;
      for (const member of page) {
        console.log('@' + member.login, member.id);
        members.set(member.id, member.login);
      }
    }
    console.log('\n');

    console.log('PRS to ssb-db:');
    for await (const response of octokit.paginate.iterator(
      octokit.rest.pulls.list,
      {owner: org, repo: 'ssb-db', state: 'closed'},
    )) {
      const page = response.data;
      for (const pr of page) {
        console.log(pr);
        // if (pr.merged_at) {
        //   const mergedBy = members.get(pr.merged_by.id);
        //   console.log('  Merged by:', mergedBy);
        // }
      }
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
