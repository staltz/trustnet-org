const core = require('@actions/core');
const github = require('@actions/github');

async function run() {
  try {
    const token = core.getInput('token');
    const org = core.getInput('org');

    const octokit = github.getOctokit(token);

    const listForOrg = octokit.rest.repos.listForOrg({org, type: 'sources'});
    for await (const response of octokit.paginate.iterator(listForOrg)) {
      // do whatever you want with each response, break out of the loop, etc.
      console.log(response);
      core.info(response);
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
