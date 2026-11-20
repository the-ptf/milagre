const { checkDesignCode } = require("@milagre/shared/artifact-document");

const MAX_HTML = 1_000_000;
function checkDesignHtml(html) {
  if (typeof html !== "string" || !html.trim()) throw Error("An interactive design needs its HTML.");
  if (html.length > MAX_HTML) throw Error(`An interactive design's HTML is limited to ${MAX_HTML} characters.`);
  const problems = checkDesignCode(html);
  if (problems.length) throw Error(problems.join(" "));
  return html;
}
function editDesignHtml(html, edits) {
  if (!Array.isArray(edits) || !edits.length) throw Error("Send at least one edit.");
  let next = html;
  edits.forEach((edit, index) => {
    const find = edit?.find;
    if (typeof find !== "string" || !find) throw Error(`Edit ${index + 1} needs the text to find.`);
    if (typeof edit.replace !== "string") throw Error(`Edit ${index + 1} needs the text to replace it with.`);
    const count = next.split(find).length - 1;
    if (!count) throw Error(`Edit ${index + 1}: its text isn't in the design (after the edits before it). Read the design again with design_read.`);
    if (count > 1 && !edit.all)
      throw Error(`Edit ${index + 1}: its text occurs ${count} times. Include more of the text around it, or set all to replace every one.`);
    next = edit.all ? next.split(find).join(edit.replace) : next.replace(find, () => edit.replace);
  });
  return next;
}

module.exports = { MAX_HTML, checkDesignHtml, editDesignHtml };
