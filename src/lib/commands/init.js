'use strict';

module.exports = function(dep) {
    let cmd = {};

    cmd.command = 'init';
    cmd.desc =
        'initializes a new Baker environment by creating a baker.yml file';
    cmd.builder = {};
    cmd.handler = async function(argv) {
        const { baker, print, spinner, spinnerDot } = dep;

        try {
            await spinner.spinPromise(baker.init(), 'Creating baker.yml in current directory', spinnerDot);
        } catch (err){
            print.error(err);
        }
    };

    return cmd;
};
