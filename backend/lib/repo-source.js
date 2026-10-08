// Resolve the actual default/selected branch without main/master assumptions.
// All subsequent tree and content reads must use this same selected ref.
async function repoSource(get, repo, selected = '') {
  selected = String(selected || '').trim();
  if (selected && !/^[A-Za-z0-9._/-]+$/.test(selected)) throw new Error('bad branch name');
  const base = `/repos/${repo}`;
  const [info, listed] = await Promise.all([
    get(base),
    get(base + '/branches?per_page=100').catch(() => null)
  ]);
  const defaultBranch = info.default_branch;
  const branch = selected || defaultBranch;
  if (!branch || !/^[A-Za-z0-9._/-]+$/.test(branch)) throw new Error('repository branch is missing or uses unsupported characters');
  const branches = [...new Set([defaultBranch, branch, ...(Array.isArray(listed) ? listed.map(b => b.name) : [])])].filter(b => b && /^[A-Za-z0-9._/-]+$/.test(b));
  return { branch, defaultBranch, branches, branchesTruncated: !listed || listed.length === 100 };
}

module.exports = { repoSource };
