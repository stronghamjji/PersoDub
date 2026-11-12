// The page's links into Perso.

/** A link into Perso with the app's utm tail (GET /api/settings perso_utm)
    and the pressed button as utm_content, so Perso's web analytics say which
    button of which app and version brought the visit. No tail yet: the bare link. */
export function persoLink(url, content, utm) {
  if (!utm) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${utm}&utm_content=${encodeURIComponent(content)}`;
}

/** Where a Perso API dubbing's result is on Perso's site: its project's page
    (owner, from the real site, 2026-10-28; the "en" is Perso's own, and no
    other Perso link here picks a language), or the workspace when the job
    never learnt its project. Pressed as utm_content "result". */
export function persoResultLink(projectSeq, utm) {
  const page = Number.isInteger(projectSeq) && projectSeq > 0
    ? `https://perso.ai/en/workspace/vt/detail/${projectSeq}` : "https://perso.ai/workspace/vt";
  return persoLink(page, "result", utm);
}
