// What a caught value says, as text. Most are Errors, but a rejection can carry
// a plain string (or anything else), and an Error with an empty message says
// nothing -- so the value itself, as text, stands in for the message.
export function errorText(err) {
  const said = String((err && err.message) || err);
  // A system error's code and path, when its message carries neither: the
  // message is in the computer's own language, the code reads the same
  // everywhere, and node's fs errors already hold both.
  if (!err || typeof err !== "object") return said;
  const tail = [err.code, err.path].filter((v) => typeof v === "string" && v && !said.includes(v));
  return tail.length ? `${said} [${tail.join(" ")}]` : said;
}
