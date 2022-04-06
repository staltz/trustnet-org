const core = require('@actions/core');
const github = require('@actions/github');

async function run() {
  try {
    const token = core.getInput('token');
    const org = core.getInput('org');

    const octokit = github.getOctokit(token);

    for await (const response of octokit.paginate.iterator(
      octokit.rest.repos.listForOrg,
      {org, type: 'sources'},
    )) {
      const page = response.data
      for (const repo of page) {
        console.log(repo.name);
      }
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
