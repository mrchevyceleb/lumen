// Match authentication failures, rather than tool permission/approval failures.
const authError = (text) => /failed to authenticate|authentication[_ ](?:failed|required)|not[_ ]authenticated|OAuth.*(?:expired|revoked|refresh|invalid)|(?:access|refresh)[_ ]token.*(?:expired|revoked|invalid|reused)|invalid[_ ](?:api[_ ]key|authentication credentials)|incorrect API key|API key.*(?:missing|invalid|not (?:found|set|configured))|no (?:API key|credentials)|not (?:logged|signed) in|please (?:log|sign) in/i.test(String(text));
module.exports = { authError };
