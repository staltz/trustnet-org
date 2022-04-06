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
      console.log('got a response');
      console.log(response.data);
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
