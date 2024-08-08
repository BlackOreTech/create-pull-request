import * as core from '@actions/core'
import {Inputs} from './create-pull-request'
import {Commit} from './git-command-manager'
import {Octokit, OctokitOptions} from './octokit-client'
import type {
  Repository as TempRepository,
  Ref,
  Commit as CommitTemp,
  FileChanges
} from '@octokit/graphql-schema'
import {BranchFileChanges} from './create-or-update-branch'
import * as utils from './utils'

const ERROR_PR_REVIEW_TOKEN_SCOPE =
  'Validation Failed: "Could not resolve to a node with the global id of'

interface Repository {
  owner: string
  repo: string
}

interface Pull {
  number: number
  html_url: string
  created: boolean
}

type TreeObject = {
  path: string
  mode: '100644' | '100755' | '040000' | '160000' | '120000'
  sha: string | null
  type: 'blob'
}

export class GitHubHelper {
  private octokit: InstanceType<typeof Octokit>

  constructor(githubServerHostname: string, token: string) {
    const options: OctokitOptions = {}
    if (token) {
      options.auth = `${token}`
    }
    if (githubServerHostname !== 'github.com') {
      options.baseUrl = `https://${githubServerHostname}/api/v3`
    } else {
      options.baseUrl = 'https://api.github.com'
    }
    this.octokit = new Octokit(options)
  }

  private parseRepository(repository: string): Repository {
    const [owner, repo] = repository.split('/')
    return {
      owner: owner,
      repo: repo
    }
  }

  private async createOrUpdate(
    inputs: Inputs,
    baseRepository: string,
    headRepository: string
  ): Promise<Pull> {
    const [headOwner] = headRepository.split('/')
    const headBranch = `${headOwner}:${inputs.branch}`

    // Try to create the pull request
    try {
      core.info(`Attempting creation of pull request`)
      const {data: pull} = await this.octokit.rest.pulls.create({
        ...this.parseRepository(baseRepository),
        title: inputs.title,
        head: headBranch,
        head_repo: headRepository,
        base: inputs.base,
        body: inputs.body,
        draft: inputs.draft
      })
      core.info(
        `Created pull request #${pull.number} (${headBranch} => ${inputs.base})`
      )
      return {
        number: pull.number,
        html_url: pull.html_url,
        created: true
      }
    } catch (e) {
      if (
        utils.getErrorMessage(e).includes(`A pull request already exists for`)
      ) {
        core.info(`A pull request already exists for ${headBranch}`)
      } else {
        throw e
      }
    }

    // Update the pull request that exists for this branch and base
    core.info(`Fetching existing pull request`)
    const {data: pulls} = await this.octokit.rest.pulls.list({
      ...this.parseRepository(baseRepository),
      state: 'open',
      head: headBranch,
      base: inputs.base
    })
    core.info(`Attempting update of pull request`)
    const {data: pull} = await this.octokit.rest.pulls.update({
      ...this.parseRepository(baseRepository),
      pull_number: pulls[0].number,
      title: inputs.title,
      body: inputs.body
    })
    core.info(
      `Updated pull request #${pull.number} (${headBranch} => ${inputs.base})`
    )
    return {
      number: pull.number,
      html_url: pull.html_url,
      created: false
    }
  }

  async getRepositoryParent(headRepository: string): Promise<string | null> {
    const {data: headRepo} = await this.octokit.rest.repos.get({
      ...this.parseRepository(headRepository)
    })
    if (!headRepo.parent) {
      return null
    }
    return headRepo.parent.full_name
  }

  async createOrUpdatePullRequest(
    inputs: Inputs,
    baseRepository: string,
    headRepository: string
  ): Promise<Pull> {
    // Create or update the pull request
    const pull = await this.createOrUpdate(
      inputs,
      baseRepository,
      headRepository
    )

    // Apply milestone
    if (inputs.milestone) {
      core.info(`Applying milestone '${inputs.milestone}'`)
      await this.octokit.rest.issues.update({
        ...this.parseRepository(baseRepository),
        issue_number: pull.number,
        milestone: inputs.milestone
      })
    }
    // Apply labels
    if (inputs.labels.length > 0) {
      core.info(`Applying labels '${inputs.labels}'`)
      await this.octokit.rest.issues.addLabels({
        ...this.parseRepository(baseRepository),
        issue_number: pull.number,
        labels: inputs.labels
      })
    }
    // Apply assignees
    if (inputs.assignees.length > 0) {
      core.info(`Applying assignees '${inputs.assignees}'`)
      await this.octokit.rest.issues.addAssignees({
        ...this.parseRepository(baseRepository),
        issue_number: pull.number,
        assignees: inputs.assignees
      })
    }

    // Request reviewers and team reviewers
    const requestReviewersParams = {}
    if (inputs.reviewers.length > 0) {
      requestReviewersParams['reviewers'] = inputs.reviewers
      core.info(`Requesting reviewers '${inputs.reviewers}'`)
    }
    if (inputs.teamReviewers.length > 0) {
      const teams = utils.stripOrgPrefixFromTeams(inputs.teamReviewers)
      requestReviewersParams['team_reviewers'] = teams
      core.info(`Requesting team reviewers '${teams}'`)
    }
    if (Object.keys(requestReviewersParams).length > 0) {
      try {
        await this.octokit.rest.pulls.requestReviewers({
          ...this.parseRepository(baseRepository),
          pull_number: pull.number,
          ...requestReviewersParams
        })
      } catch (e) {
        if (utils.getErrorMessage(e).includes(ERROR_PR_REVIEW_TOKEN_SCOPE)) {
          core.error(
            `Unable to request reviewers. If requesting team reviewers a 'repo' scoped PAT is required.`
          )
        }
        throw e
      }
    }

    return pull
  }

  async pushSignedCommits(
    branchCommits: Commit[],
    repoPath: string,
    branchRepository: string,
    branch: string
  ): Promise<void> {
    let headSha = ''
    for (const commit of branchCommits) {
      headSha = await this.createCommit(commit, repoPath, branchRepository)
    }
    await this.createOrUpdateRef(branchRepository, branch, headSha)
  }

  private async createCommit(
    commit: Commit,
    repoPath: string,
    branchRepository: string
  ): Promise<string> {
    const repository = this.parseRepository(branchRepository)
    let treeSha = commit.tree
    if (commit.changes.length > 0) {
      core.debug(`Creating tree objects for local commit ${commit.sha}`)
      const treeObjects = await Promise.all(
        commit.changes.map(async ({path, mode, status}) => {
          let sha: string | null = null
          if (status === 'A' || status === 'M') {
            core.debug(`Creating blob for file '${path}'`)
            const {data: blob} = await this.octokit.rest.git.createBlob({
              ...repository,
              content: utils.readFileBase64([repoPath, path]),
              encoding: 'base64'
            })
            sha = blob.sha
          }
          return <TreeObject>{
            path,
            mode,
            sha,
            type: 'blob'
          }
        })
      )
      core.debug(`Creating tree for local commit ${commit.sha}`)
      const {data: tree} = await this.octokit.rest.git.createTree({
        ...repository,
        base_tree: commit.parents[0],
        tree: treeObjects
      })
      treeSha = tree.sha
      core.debug(`Created tree ${treeSha} for local commit ${commit.sha}`)
    }

    const {data: remoteCommit} = await this.octokit.rest.git.createCommit({
      ...repository,
      parents: commit.parents,
      tree: treeSha,
      message: `${commit.subject}\n\n${commit.body}`
    })
    core.debug(
      `Created commit ${remoteCommit.sha} for local commit ${commit.sha}`
    )
    return remoteCommit.sha
  }

  private async createOrUpdateRef(
    branchRepository: string,
    branch: string,
    newHead: string
  ) {
    const repository = this.parseRepository(branchRepository)
    const branchExists = await this.octokit.rest.git
      .getRef({
        ...repository,
        ref: branch
      })
      .then(
        () => true,
        () => false
      )

    if (branchExists) {
      core.debug(`Branch ${branch} exists, updating ref`)
      await this.octokit.rest.git.updateRef({
        ...repository,
        sha: newHead,
        ref: `heads/${branch}`
      })
    } else {
      core.debug(`Branch ${branch} does not exist, creating ref`)
      await this.octokit.rest.git.createRef({
        ...repository,
        sha: newHead,
        ref: `refs/heads/${branch}`
      })
    }
  }

  async pushSignedCommit(
    branchRepository: string,
    branch: string,
    base: string,
    commitMessage: string,
    branchFileChanges?: BranchFileChanges
  ): Promise<void> {
    core.info(`Use API to push a signed commit`)

    const [repoOwner, repoName] = branchRepository.split('/')
    core.debug(`repoOwner: '${repoOwner}', repoName: '${repoName}'`)
    const refQuery = `
        query GetRefId($repoName: String!, $repoOwner: String!, $branchName: String!) {
          repository(owner: $repoOwner, name: $repoName){
            id
            ref(qualifiedName: $branchName){
              id
              name
              prefix
              target{
                id
                oid
                commitUrl
                commitResourcePath
                abbreviatedOid
              }
            }
          },
        }
      `

    let branchRef = await this.octokit.graphql<{repository: TempRepository}>(
      refQuery,
      {
        repoOwner: repoOwner,
        repoName: repoName,
        branchName: branch
      }
    )
    core.debug(
      `Fetched information for branch '${branch}' - '${JSON.stringify(branchRef)}'`
    )

    // if the branch does not exist, then first we need to create the branch from base
    if (branchRef.repository.ref == null) {
      core.debug(`Branch does not exist - '${branch}'`)
      branchRef = await this.octokit.graphql<{repository: TempRepository}>(
        refQuery,
        {
          repoOwner: repoOwner,
          repoName: repoName,
          branchName: base
        }
      )
      core.debug(
        `Fetched information for base branch '${base}' - '${JSON.stringify(branchRef)}'`
      )

      core.info(
        `Creating new branch '${branch}' from '${base}', with ref '${JSON.stringify(branchRef.repository.ref!.target!.oid)}'`
      )
      if (branchRef.repository.ref != null) {
        core.debug(`Send request for creating new branch`)
        const newBranchMutation = `
          mutation CreateNewBranch($branchName: String!, $oid: GitObjectID!, $repoId: ID!) {
            createRef(input: {
              name: $branchName,
              oid: $oid,
              repositoryId: $repoId
            }) {
              ref {
                id
                name
                prefix
              }
            }
          }
        `
        const newBranch = await this.octokit.graphql<{createRef: {ref: Ref}}>(
          newBranchMutation,
          {
            repoId: branchRef.repository.id,
            oid: branchRef.repository.ref.target!.oid,
            branchName: 'refs/heads/' + branch
          }
        )
        core.debug(
          `Created new branch '${branch}': '${JSON.stringify(newBranch.createRef.ref)}'`
        )
      }
    }
    core.info(
      `Hash ref of branch '${branch}' is '${JSON.stringify(branchRef.repository.ref!.target!.oid)}'`
    )

    const fileChanges = <FileChanges>{
      additions: branchFileChanges!.additions,
      deletions: branchFileChanges!.deletions
    }

    const pushCommitMutation = `
      mutation PushCommit(
        $repoNameWithOwner: String!,
        $branchName: String!,
        $headOid: GitObjectID!,
        $commitMessage: String!,
        $fileChanges: FileChanges
      ) {
        createCommitOnBranch(input: {
          branch: {
            repositoryNameWithOwner: $repoNameWithOwner,
            branchName: $branchName,
          }
          fileChanges: $fileChanges
          message: {
            headline: $commitMessage
          }
          expectedHeadOid: $headOid
        }){
          clientMutationId
          ref{
            id
            name
            prefix
          }
          commit{
            id
            abbreviatedOid
            oid
          }
        }
      }
    `
    const pushCommitVars = {
      branchName: branch,
      repoNameWithOwner: repoOwner + '/' + repoName,
      headOid: branchRef.repository.ref!.target!.oid,
      commitMessage: commitMessage,
      fileChanges: fileChanges
    }

    const pushCommitVarsWithoutContents = {
      ...pushCommitVars,
      fileChanges: {
        ...pushCommitVars.fileChanges,
        additions: pushCommitVars.fileChanges.additions?.map(addition => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const {contents, ...rest} = addition
          return rest
        })
      }
    }

    core.debug(
      `Push commit with payload: '${JSON.stringify(pushCommitVarsWithoutContents)}'`
    )

    const commit = await this.octokit.graphql<{
      createCommitOnBranch: {ref: Ref; commit: CommitTemp}
    }>(pushCommitMutation, pushCommitVars)

    core.debug(`Pushed commit - '${JSON.stringify(commit)}'`)
    core.info(
      `Pushed commit with hash - '${commit.createCommitOnBranch.commit.oid}' on branch - '${commit.createCommitOnBranch.ref.name}'`
    )
  }
}
