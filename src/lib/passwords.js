const bcrypt = require('bcryptjs');

module.exports = {
  hash: (plain) => bcrypt.hashSync(String(plain), 10),
  verify: (plain, hash) => {
    try { return bcrypt.compareSync(String(plain), String(hash)); }
    catch { return false; }
  },
};
