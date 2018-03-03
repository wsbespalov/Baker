const Baker     = require('../modules/baker');
const Print     = require('../modules/print');
const Spinner   = require('../modules/spinner');

const { spinnerDot } = require('../../global-vars');

exports.command = 'boxes';
exports.desc = `list existing Baker boxes`;
exports.handler = async function(argv) {
    const { verbose } = argv;

    try {
        await Spinner.spinPromise(Baker.bakerBoxes(), `Getting list of Baker boxes`, spinnerDot);
    } catch (err) {
        Print.error(err);
    }
}
