const Promise       = require('bluebird');
const child_process = require('child_process');
const conf          = require('../../lib/modules/configstore');
const download      = require('download');
const fs            = require('fs-extra');
const mustache      = require('mustache');
const path          = require('path');
const print         = require('./print');
const Ssh           = require('./ssh');
const Utils         = require('./utils/utils');
const vagrant       = Promise.promisifyAll(require('node-vagrant'));
const yaml          = require('js-yaml');
const Spinner       = require('../modules/spinner');
const spinnerDot    = conf.get('spinnerDot');

const vbox          =      require('node-virtualbox');
const VBoxProvider  =      require('node-virtualbox/lib/VBoxProvider');
const VagrantProvider    = require('./providers/vagrant');
const VagrantProviderObj = new VagrantProvider();

const { configPath, ansible, boxes, bakerForMacPath } = require('../../global-vars');

class Servers {
    constructor() {}

    /**
     * Checks if ansible server is up, if not it starts the server
     * It will also copy new vm's ansible script to ~/baker/{name}/ in ansible server
     */
    static async prepareAnsibleServer(bakerScriptPath) {
        let machine = vagrant.create({ cwd: ansible });
        let doc = yaml.safeLoad(await fs.readFile(path.join(bakerScriptPath, 'baker.yml'), 'utf8'));

        try {
            // let bakerVMID = await VagrantProvider.getVagrantID('baker');
            // let state = await this.getState(bakerVMID);
            let state = await VagrantProvider.getState('baker');
            if (state === 'running') {
                let ansibleSSHConfig = await VagrantProviderObj.getSSHConfig(machine);
                await Ssh.copyFilesForAnsibleServer(bakerScriptPath, doc, ansibleSSHConfig);
                return machine;
            } else {
                try {
                    await machine.upAsync();
                    // machine.on('up-progress', function(data) {
                    //     print.info(data);
                    // });
                } catch (err) {
                    throw err;
                }
                let ansibleSSHConfig = await this.getSSHConfig(machine);

                await Ssh.copyFilesForAnsibleServer(bakerScriptPath, doc, ansibleSSHConfig);

                return machine;
            }
        } catch (err) {
            if (err === `Cannot find machine: baker`) {
                throw `Baker control machine is not installed. run \`baker setup\` to install control machine`;
            } else {
                throw err;
            }
        }
    }


    /**
     * Make sure DockerVM exists
     * @param {String} custom name of the VM to be used as Docker host.
     *                          if undefined, usinig default Docker host.
     */
    static async prepareDockerVM(custom){
        if(!custom) {
            const dockerHostName = 'docker-srv';
            const dockerHostPath = path.join(boxes, dockerHostName);


            // console.log('dockerHostName', dockerHostName);
            // console.log('dockerHostPath', dockerHostPath)

            // preparing the ansibler server (needed for bakelets)
            // ansibleVM = await this.prepareAnsibleServer(bakePath); // need to ensure baker server is running?
            let ansibleVM = vagrant.create({ cwd: ansible });
            let ansibleSSHConfig = await VagrantProviderObj.getSSHConfig(ansibleVM);

            // ensure needed dir exist
            await Utils._ensureDir(boxes);
            await Utils._ensureDir(dockerHostPath);

            // always update vagrantfile
            let template = await fs.readFile(path.join(configPath, './dockerHost/DockerVM.mustache'), 'utf8');
            let vagrantfile = mustache.render(template, {dockerHostName});
            await fs.writeFile(path.join(dockerHostPath, 'Vagrantfile'), vagrantfile);

            let status;
            try{
                await VagrantProvider.getState('docker-srv')
                status = await VagrantProvider.getState('docker-srv');
            } catch(err){
                if (err == 'Cannot find machine: docker-srv') {
                    // Install baker-srv
                    await Utils._ensureDir(boxes);
                    await Utils._ensureDir(dockerHostPath);

                    await Utils.copyFileSync(path.join(configPath, './dockerHost/dockerConfig.yml'), path.join(dockerHostPath), 'dockerConfig.yml');
                    await Utils.copyFileSync(path.join(configPath, './dockerHost/lxd-bridge'), path.join(dockerHostPath), 'lxd-bridge');

                    await this.installDocker(ansibleSSHConfig);
                } else {
                    throw err;
                }
            }

            let machine = vagrant.create({ cwd: dockerHostPath });
            try {
                // TODO: Add a force reload option
                if(status != 'running'){
                    machine.on('up-progress', function(data) {
                        print.info(data);
                    });
                    await machine.upAsync();
                }
            } catch (err) {
                throw `Failed to start host VM: ${dockerHostName}\n${err}`;
            }
        } else {
            // TODO: custom docker hosts
            console.log('Docker-srv is running!')
        }
    }

    static async installBakerServer() {
        if (require('os').platform() === 'darwin') {
            await this.setupBakerForMac();
        } else {
            // TODO: check if virtualbox is installed
            // TODO: update node-virtualbox to return the port if it has to use something else
            await vbox({
                micro: true,
                vmname: 'baker',
                port: 6022,
                verbose: true
            });
        }
    }

    /**
     * Creates ansible server, if already doesn't exist
     */
    static async installAnsibleServer () {
        try {
            await fs.ensureDir(boxes);
            await fs.ensureDir(ansible);
        } catch (err) {
            throw err;
        }

        let machine = vagrant.create({ cwd: ansible });
        let bakerVMState;

        try {
            bakerVMState = await VagrantProvider.getState('baker');
            if(bakerVMState == 'running') return;
        } catch (err) {
            if (err === `Cannot find machine: baker`) {
                let template = await fs.readFile(path.join(configPath, './AnsibleVM.mustache'), 'utf8');
                let vagrantfile = mustache.render(template, require('../../config/AnsibleVM'));
                await fs.writeFile(path.join(ansible, 'Vagrantfile'), vagrantfile)

                await Utils.copyFileSync(
                    path.resolve(configPath, './provision.shell.sh'),
                    path.resolve(ansible),
                    'provision.shell.sh'
                );
            } else {
                throw err;
            }
        }

        try {
            await machine.upAsync();
        } catch (err) {
            throw `Failed to start Baker control machine`;
        }

        // machine.on('up-progress', function(data) {
        //     print.info(data);
        // });

        let sshConfig = await machine.sshConfigAsync();
        Utils.addToIndex('baker', ansible, 'vm', sshConfig);

        return;
    }

    /**
     * Re-installs ansible server.
     * @returns Promise
     */
    static async reinstallAnsibleServer () {
        try {
            await (new VagrantProvider()).delete('baker');
            Utils.removeFromIndex('baker');
        } catch (err) {
            if (err != `Cannot find machine: baker`) {
                throw err;
            }
        }
        await this.installAnsibleServer();
        return;
    }

    // TODO: Temp: refactor to be able to use the docker bakelet instead
    static async installDocker(sshConfig) {
        return Ssh.sshExec(`cd /home/vagrant/baker/ && ansible-playbook -i "localhost," installDocker.yml -c local`, sshConfig, false);
    }

    // also in provider.vagrant
    /**
     * Adds the host url to /etc/hosts
     *
     * @param {String} ip
     * @param {String} name
     * @param {Object} sshConfig
     */
    async addToAnsibleHosts (ip, name, ansibleSSHConfig, vmSSHConfig){
        // TODO: Consider also specifying ansible_connection=${} to support containers etc.
        // TODO: Callers of this can be refactored to into two methods, below:
        return Ssh.sshExec(`echo "[${name}]\n${ip}\tansible_ssh_private_key_file=${ip}_rsa\tansible_user=${vmSSHConfig.user}" > /home/vagrant/baker/${name}/baker_inventory && ansible all -i "localhost," -m lineinfile -a "dest=/etc/hosts line='${ip} ${name}' state=present" -c local --become`, ansibleSSHConfig);
    }

    static async setupBakerForMac(force=undefined){
        if(force){
            await fs.remove(bakerForMacPath);
        }

        await fs.ensureDir(bakerForMacPath);
        await Utils.copyFileSync(path.join(configPath, 'BakerForMac', 'vendor', 'hyperkit'), path.join(bakerForMacPath, 'vendor'), 'hyperkit');
        await fs.chmod(path.join(bakerForMacPath, 'vendor', 'hyperkit'), '511');
        await Utils.copyFileSync(path.join(configPath, 'BakerForMac', 'vendor', 'vpnkit.exe'), path.join(bakerForMacPath, 'vendor'), 'vpnkit.exe');
        await fs.chmod(path.join(bakerForMacPath, 'vendor', 'vpnkit.exe'), '511');
        await Utils.copyFileSync(path.join(configPath, 'BakerForMac', 'bakerformac.sh'), bakerForMacPath, 'bakerformac.sh');
        await fs.chmod(path.join(bakerForMacPath, 'bakerformac.sh'), '511');
        await Utils.copyFileSync(path.join(configPath, 'BakerForMac', 'hyperkitrun.sh'), bakerForMacPath, 'hyperkitrun.sh');
        await fs.chmod(path.join(bakerForMacPath, 'hyperkitrun.sh'), '511');

        // console.log('baker_rsa', await fs.readFile(path.join(configPath, 'baker_rsa'), 'utf8'));

        await Utils.copyFileSync(path.join(configPath, 'baker_rsa'), bakerForMacPath, 'baker_rsa');
        await fs.chmod(path.join(bakerForMacPath, 'baker_rsa'), '600');

        // download files if not available locally
        if (!(await fs.pathExists(path.join(bakerForMacPath, 'kernel')))) {
            await Spinner.spinPromise(download('https://github.com/ottomatica/baker-release/releases/download/0.6.0/kernel', bakerForMacPath), 'Downloading BakerForMac kernel', spinnerDot);
        }
        if (!(await fs.pathExists(path.join(bakerForMacPath, 'file.img.gz')))) {
            await Spinner.spinPromise(download('https://github.com/ottomatica/baker-release/releases/download/0.6.0/file.img.gz', bakerForMacPath), 'Downloading BakerForMac filesystem image', spinnerDot);
        }

        // only start server if not running
        child_process.execSync(`ps -fu $USER| grep "Library/Baker/BakerForMac/bakerformac.sh" | grep -v "grep" || screen -dm -S BakerForMac bash -c "${path.join(bakerForMacPath, 'bakerformac.sh')}"`, {stdio: ['ignore', 'ignore', 'inherit']});
    }
}


module.exports = Servers;
