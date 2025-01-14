const AdmZip = require('adm-zip')
const child_process = require('child_process')
const crypto = require('crypto')
const fs = require('fs-extra')
const {LoggerUtil} = require('rgblauncher-core')
const {getMojangOS, isLibraryCompatible, mcVersionAtLeast} = require('rgblauncher-core/common')
const {Type} = require('rgblauncher-distribution-types')
const os = require('os')
const path = require('path')

const ConfigManager = require('./configmanager')

const logger = LoggerUtil.getLogger('ProcessBuilder')

class ProcessBuilder {

    constructor(distroServer, versionData, forgeData, authUser, launcherVersion) {
        this.gameDir = path.join(ConfigManager.getInstanceDirectory(), distroServer.rawServer.id)
        this.commonDir = ConfigManager.getCommonDirectory()
        this.server = distroServer
        this.versionData = versionData
        this.forgeData = forgeData
        this.authUser = authUser
        this.launcherVersion = launcherVersion
        this.forgeModListFile = path.join(this.gameDir, 'forgeMods.list') // 1.13+
        this.fmlDir = path.join(this.gameDir, 'forgeModList.json')
        this.llDir = path.join(this.gameDir, 'liteloaderModList.json')
        this.libPath = path.join(this.commonDir, 'libraries')

        this.usingLiteLoader = false
        this.llPath = null
    }

    /**
     * Convienence method to run the functions typically used to build a process.
     */
    build() {
        let args = []
        args.push('-cp')
        let cpArgs = []
        let bin = 'bin'
        cpArgs.push(path.join(bin, 'jopt-simple-4.5.jar'), path.join(bin, 'jinput.jar'), path.join(bin, 'jutils-1.0.0.jar'), path.join(bin, 'lwjgl.jar'), path.join(bin, 'lwjgl_util.jar'), path.join(bin, 'legacywrapper-1.2.1.jar'), path.join(bin, 'modpack.jar'), path.join(bin, 'minecraft.jar'))
        this._processClassPathList(cpArgs)
        args.push(cpArgs.join(ProcessBuilder.getClasspathSeparator()))
        args.push('-Xmx' + ConfigManager.getMaxRAM(this.server.rawServer.id))
        args.push('-Xms' + ConfigManager.getMinRAM(this.server.rawServer.id))
        args = args.concat(ConfigManager.getJVMOptions(this.server.rawServer.id))
        args.push('-Djava.library.path=' + path.join(bin, 'natives'))
        args.push('-Dfml.ignoreInvalidMinecraftCertificates=true')
        args.push('-Dfml.ignorePatchDiscrepancies=true')
        args.push('-Dminecraft.applet.TargetDirectory=.')
        if (this.server.rawServer.id.endsWith('FPS')) {
            args.push('net.minecraft.client.Minecraft')
        } else {
            args.push('net.technicpack.legacywrapper.Launch')
        }
        args = args.concat(this._resolveForgeArgs())

        // build() {
        //     fs.ensureDirSync(this.gameDir)
        //     const tempNativePath = path.join(os.tmpdir(), ConfigManager.getTempNativeFolder(), crypto.pseudoRandomBytes(16).toString('hex'))
        //     process.throwDeprecation = true
        //     // this.setupLiteLoader()
        //     logger.info('Using liteloader:', this.usingLiteLoader)
        //     const modObj = this.resolveModConfiguration(ConfigManager.getModConfiguration(this.server.rawServer.id).mods, this.server.modules)
        //
        //     // Mod list below 1.13
        //     // if (!mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)) {
        //     //     this.constructJSONModList('forge', modObj.fMods, true)
        //     //     if (this.usingLiteLoader) {
        //     //         this.constructJSONModList('liteloader', modObj.lMods, true)
        //     //     }
        //     // }
        //
        //     const uberModArr = modObj.fMods.concat(modObj.lMods)
        //     let args = this.constructJVMArguments(uberModArr, tempNativePath)
        //
        //     if (mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)) {
        //         //args = args.concat(this.constructModArguments(modObj.fMods))
        //         args = args.concat(this.constructModList(modObj.fMods))
        //     }
        //

        logger.info('Launch Arguments:', args)
        logger.info(args.join(' '))

        const child = child_process.spawn(ConfigManager.getJavaExecutable(this.server.rawServer.id), args, {
            cwd: this.gameDir,
            detached: ConfigManager.getLaunchDetached()
        })

        if (ConfigManager.getLaunchDetached()) {
            child.unref()
        }

        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')

        child.stdout.on('data', (data) => {
            data.trim().split('\n').forEach(x => console.log(`\x1b[32m[Minecraft]\x1b[0m ${x}`))

        })
        child.stderr.on('data', (data) => {
            data.trim().split('\n').forEach(x => console.log(`\x1b[31m[Minecraft]\x1b[0m ${x}`))
        })
        child.on('close', (code, signal) => {
            logger.info('Exited with code', code)
            remote.BrowserWindow.getAllWindows()[0].show()
        })

        return child
    }

    /**
     * Get the platform specific classpath separator. On windows, this is a semicolon.
     * On Unix, this is a colon.
     *
     * @returns {string} The classpath separator for the current operating system.
     */
    static getClasspathSeparator() {
        return process.platform === 'win32' ? ';' : ':'
    }

    /**
     * Determine if an optional mod is enabled from its configuration value. If the
     * configuration value is null, the required object will be used to
     * determine if it is enabled.
     *
     * A mod is enabled if:
     *   * The configuration is not null and one of the following:
     *     * The configuration is a boolean and true.
     *     * The configuration is an object and its 'value' property is true.
     *   * The configuration is null and one of the following:
     *     * The required object is null.
     *     * The required object's 'def' property is null or true.
     *
     * @param {Object | boolean} modCfg The mod configuration object.
     * @param {Object} required Optional. The required object from the mod's distro declaration.
     * @returns {boolean} True if the mod is enabled, false otherwise.
     */
    static isModEnabled(modCfg, required = null) {
        return modCfg != null ? ((typeof modCfg === 'boolean' && modCfg) || (typeof modCfg === 'object' && (typeof modCfg.value !== 'undefined' ? modCfg.value : true))) : required != null ? required.def : true
    }

    /**
     * Function which performs a preliminary scan of the top level
     * mods. If liteloader is present here, we setup the special liteloader
     * launch options. Note that liteloader is only allowed as a top level
     * mod. It must not be declared as a submodule.
     */
    setupLiteLoader() {
        for (let ll of this.server.modules) {
            if (ll.rawModule.type === Type.LiteLoader) {
                if (!ll.getRequired().value) {
                    const modCfg = ConfigManager.getModConfiguration(this.server.rawServer.id).mods
                    if (ProcessBuilder.isModEnabled(modCfg[ll.getVersionlessMavenIdentifier()], ll.getRequired())) {
                        if (fs.existsSync(ll.getPath())) {
                            this.usingLiteLoader = true
                            this.llPath = ll.getPath()
                        }
                    }
                } else {
                    if (fs.existsSync(ll.getPath())) {
                        this.usingLiteLoader = true
                        this.llPath = ll.getPath()
                    }
                }
            }
        }
    }

    /**
     * Resolve an array of all enabled mods. These mods will be constructed into
     * a mod list format and enabled at launch.
     *
     * @param {Object} modCfg The mod configuration object.
     * @param {Array.<Object>} mdls An array of modules to parse.
     * @returns {{fMods: Array.<Object>, lMods: Array.<Object>}} An object which contains
     * a list of enabled forge mods and litemods.
     */
    resolveModConfiguration(modCfg, mdls) {
        let fMods = []
        let lMods = []

        for (let mdl of mdls) {
            const type = mdl.rawModule.type
            if (type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader) {
                const o = !mdl.getRequired().value
                const e = ProcessBuilder.isModEnabled(modCfg[mdl.getVersionlessMavenIdentifier()], mdl.getRequired())
                if (!o || (o && e)) {
                    if (mdl.subModules.length > 0) {
                        const v = this.resolveModConfiguration(modCfg[mdl.getVersionlessMavenIdentifier()].mods, mdl.subModules)
                        fMods = fMods.concat(v.fMods)
                        lMods = lMods.concat(v.lMods)
                        if (type === Type.LiteLoader) {
                            continue
                        }
                    }
                    if (type === Type.ForgeMod) {
                        fMods.push(mdl)
                    } else {
                        lMods.push(mdl)
                    }
                }
            }
        }

        return {
            fMods,
            lMods
        }
    }

    _lteMinorVersion(version) {
        return Number(this.forgeData.id.split('-')[0].split('.')[1]) <= Number(version)
    }

    /**
     * Test to see if this version of forge requires the absolute: prefix
     * on the modListFile repository field.
     */
    _requiresAbsolute() {
        try {
            if (this._lteMinorVersion(9)) {
                return false
            }
            const ver = this.forgeData.id.split('-')[2]
            const pts = ver.split('.')
            const min = [14, 23, 3, 2655]
            for (let i = 0; i < pts.length; i++) {
                const parsed = Number.parseInt(pts[i])
                if (parsed < min[i]) {
                    return false
                } else if (parsed > min[i]) {
                    return true
                }
            }
        } catch (err) {
            // We know old forge versions follow this format.
            // Error must be caused by newer version.
        }

        // Equal or errored
        return true
    }

    /**
     * Construct a mod list json object.
     *
     * @param {'forge' | 'liteloader'} type The mod list type to construct.
     * @param {Array.<Object>} mods An array of mods to add to the mod list.
     * @param {boolean} save Optional. Whether we should save the mod list file.
     */
    constructJSONModList(type, mods, save = false) {
        const modList = {
            repositoryRoot: ((type === 'forge' && this._requiresAbsolute()) ? 'absolute:' : '') + path.join(this.commonDir, 'modstore')
        }

        const ids = []
        if (type === 'forge') {
            for (let mod of mods) {
                ids.push(mod.getExtensionlessMavenIdentifier())
            }
        } else {
            for (let mod of mods) {
                ids.push(mod.getMavenIdentifier())
            }
        }
        modList.modRef = ids

        if (save) {
            const json = JSON.stringify(modList, null, 4)
            fs.writeFileSync(type === 'forge' ? this.fmlDir : this.llDir, json, 'UTF-8')
        }

        return modList
    }

    // /**
    //  * Construct the mod argument list for forge 1.13
    //  * 
    //  * @param {Array.<Object>} mods An array of mods to add to the mod list.
    //  */
    // constructModArguments(mods){
    //     const argStr = mods.map(mod => {
    //         return mod.getExtensionlessMavenIdentifier()
    //     }).join(',')

    //     if(argStr){
    //         return [
    //             '--fml.mavenRoots',
    //             path.join('..', '..', 'common', 'modstore'),
    //             '--fml.mods',
    //             argStr
    //         ]
    //     } else {
    //         return []
    //     }

    // }

    /**
     * Construct the mod argument list for forge 1.13
     *
     * @param {Array.<Object>} mods An array of mods to add to the mod list.
     */
    constructModList(mods) {
        const writeBuffer = mods.map(mod => {
            return mod.getExtensionlessMavenIdentifier()
        }).join('\n')

        if (writeBuffer) {
            fs.writeFileSync(this.forgeModListFile, writeBuffer, 'UTF-8')
            return [
                '--fml.mavenRoots',
                path.join('..', '..', 'common', 'modstore'),
                '--fml.modLists',
                this.forgeModListFile
            ]
        } else {
            return []
        }

    }

    _processAutoConnectArg(args) {
        if (ConfigManager.getAutoConnect() && this.server.rawServer.autoconnect) {
            args.push('--server')
            args.push('kamino.a-centauri.com')
            args.push('--port')
            args.push('25565')
        }
    }

    /**
     * Construct the argument array that will be passed to the JVM process.
     *
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {Array.<string>} An array containing the full JVM arguments for this process.
     */
    constructJVMArguments(mods, tempNativePath) {
        if (mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)) {
            return this._constructJVMArguments113(mods, tempNativePath)
        } else {
            return this._constructJVMArguments112(mods, tempNativePath)
        }
    }

    /**
     * Construct the argument array that will be passed to the JVM process.
     * This function is for 1.12 and below.
     *
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {Array.<string>} An array containing the full JVM arguments for this process.
     */
    _constructJVMArguments112(mods, tempNativePath) {

        let args = []

        // Classpath Argument
        args.push('-cp')
        args.push(this.classpathArg(mods, tempNativePath).join(ProcessBuilder.getClasspathSeparator()))

        // Java Arguments
        if (process.platform === 'darwin') {
            args.push('-Xdock:name=RGBLauncher')
            args.push('-Xdock:icon=' + path.join(__dirname, '..', 'images', 'RGB.icns'))
        }
        args.push('-Xmx' + ConfigManager.getMaxRAM(this.server.rawServer.id))
        args.push('-Xms' + ConfigManager.getMinRAM(this.server.rawServer.id))
        args = args.concat(ConfigManager.getJVMOptions(this.server.rawServer.id))
        args.push('-Djava.library.path=' + tempNativePath)

        // Main Java Class
        args.push(this.forgeData.mainClass)

        // Forge Arguments
        args = args.concat(this._resolveForgeArgs())

        return args
    }

    /**
     * Resolve the arguments required by forge.
     *
     * @returns {Array.<string>} An array containing the arguments required by forge.
     */
    _resolveForgeArgs() {
        // const mcArgs = this.forgeData.minecraftArguments.split(' ')
        const argDiscovery = /\${*(.*)}/

        let mcArgs = []
        mcArgs.push(
            '${auth_player_name}', '--assetsDir', '${assets_root}', '--gameDir', '${game_directory}',
            '--icon', 'icon.png', '--title', this.server.rawServer.name
        )

        // Replace the declared variables with their proper values.
        for (let i = 0; i < mcArgs.length; ++i) {
            if (argDiscovery.test(mcArgs[i])) {
                const identifier = mcArgs[i].match(argDiscovery)[1]
                let val = null
                switch (identifier) {
                    case 'auth_player_name':
                        val = this.authUser.displayName.trim()
                        break
                    case 'version_name':
                        //val = versionData.id
                        val = this.server.rawServer.id
                        break
                    case 'game_directory':
                        val = this.gameDir
                        break
                    case 'assets_root':
                        val = path.join(this.gameDir, 'resources')
                        break
                    case 'assets_index_name':
                        val = this.versionData.assets
                        break
                    case 'auth_uuid':
                        val = this.authUser.uuid.trim()
                        break
                    case 'auth_access_token':
                        val = this.authUser.accessToken
                        break
                    case 'user_type':
                        val = this.authUser.type === 'microsoft' ? 'msa' : 'mojang'
                        break
                    case 'user_properties': // 1.8.9 and below.
                        val = '{}'
                        break
                    case 'version_type':
                        val = this.versionData.type
                        break
                }
                if (val != null) {
                    mcArgs[i] = val
                }
            }
        }

        // Autoconnect to the selected server.
        this._processAutoConnectArg(mcArgs)

        // Prepare game resolution
        if (ConfigManager.getFullscreen()) {
            mcArgs.push('--fullscreen')
            mcArgs.push(true)
        } /*else {
            mcArgs.push('--width')
            mcArgs.push(ConfigManager.getGameWidth())
            mcArgs.push('--height')
            mcArgs.push(ConfigManager.getGameHeight())
        }*/

        // // Mod List File Argument
        // mcArgs.push('--modListFile')
        // if (this._lteMinorVersion(9)) {
        //     mcArgs.push(path.basename(this.fmlDir))
        // } else {
        //     mcArgs.push('absolute:' + this.fmlDir)
        // }


        // // LiteLoader
        // if (this.usingLiteLoader) {
        //     mcArgs.push('--modRepo')
        //     mcArgs.push(this.llDir)
        //
        //     // Set first arg to liteloader tweak class
        //     mcArgs.unshift('com.mumfrey.liteloader.launch.LiteLoaderTweaker')
        //     mcArgs.unshift('--tweakClass')
        // }

        return mcArgs
    }

    /**
     * Ensure that the classpath entries all point to jar files.
     *
     * @param {Array.<String>} list Array of classpath entries.
     */
    _processClassPathList(list) {

        const ext = '.jar'
        const extLen = ext.length
        for (let i = 0; i < list.length; i++) {
            const extIndex = list[i].indexOf(ext)
            if (extIndex > -1 && extIndex !== list[i].length - extLen) {
                list[i] = list[i].substring(0, extIndex + extLen)
            }
        }

    }

    /**
     * Resolve the full classpath argument list for this process. This method will resolve all Mojang-declared
     * libraries as well as the libraries declared by the server. Since mods are permitted to declare libraries,
     * this method requires all enabled mods as an input
     *
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {Array.<string>} An array containing the paths of each library required by this process.
     */
    classpathArg(mods, tempNativePath) {
        let cpArgs = []

        if (!mcVersionAtLeast('1.17', this.server.rawServer.minecraftVersion)) {
            // Add the version.jar to the classpath.
            // Must not be added to the classpath for Forge 1.17+.
            const version = this.versionData.id
            cpArgs.push(path.join(this.commonDir, 'versions', version, version + '.jar'))
        }


        if (this.usingLiteLoader) {
            cpArgs.push(this.llPath)
        }

        // Resolve the Mojang declared libraries.
        const mojangLibs = this._resolveMojangLibraries(tempNativePath)

        // Resolve the server declared libraries.
        const servLibs = this._resolveServerLibraries(mods)

        // Merge libraries, server libs with the same
        // maven identifier will override the mojang ones.
        // Ex. 1.7.10 forge overrides mojang's guava with newer version.
        const finalLibs = {...mojangLibs, ...servLibs}
        cpArgs = cpArgs.concat(Object.values(finalLibs))

        this._processClassPathList(cpArgs)

        return cpArgs
    }

    /**
     * Resolve the libraries defined by Mojang's version data. This method will also extract
     * native libraries and point to the correct location for its classpath.
     *
     * TODO - clean up function
     *
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {{[id: string]: string}} An object containing the paths of each library mojang declares.
     */
    _resolveMojangLibraries(tempNativePath) {
        const nativesRegex = /.+:natives-([^-]+)(?:-(.+))?/
        const libs = {}

        const libArr = this.versionData.libraries
        fs.ensureDirSync(tempNativePath)
        for (let i = 0; i < libArr.length; i++) {
            const lib = libArr[i]
            if (isLibraryCompatible(lib.rules, lib.natives)) {

                // Pre-1.19 has a natives object.
                if (lib.natives != null) {
                    // Extract the native library.
                    const exclusionArr = lib.extract != null ? lib.extract.exclude : ['META-INF/']
                    const artifact = lib.downloads.classifiers[lib.natives[getMojangOS()].replace('${arch}', process.arch.replace('x', ''))]

                    // Location of native zip.
                    const to = path.join(this.libPath, artifact.path)

                    let zip = new AdmZip(to)
                    let zipEntries = zip.getEntries()

                    // Unzip the native zip.
                    for (let i = 0; i < zipEntries.length; i++) {
                        const fileName = zipEntries[i].entryName

                        let shouldExclude = false

                        // Exclude noted files.
                        exclusionArr.forEach(function (exclusion) {
                            if (fileName.indexOf(exclusion) > -1) {
                                shouldExclude = true
                            }
                        })

                        // Extract the file.
                        if (!shouldExclude) {
                            fs.writeFile(path.join(tempNativePath, fileName), zipEntries[i].getData(), (err) => {
                                if (err) {
                                    logger.error('Error while extracting native library:', err)
                                }
                            })
                        }

                    }
                }
                // 1.19+ logic
                else if (lib.name.includes('natives-')) {

                    const regexTest = nativesRegex.exec(lib.name)
                    // const os = regexTest[1]
                    const arch = regexTest[2] ?? 'x64'

                    if (arch != process.arch) {
                        continue
                    }

                    // Extract the native library.
                    const exclusionArr = lib.extract != null ? lib.extract.exclude : ['META-INF/', '.git', '.sha1']
                    const artifact = lib.downloads.artifact

                    // Location of native zip.
                    const to = path.join(this.libPath, artifact.path)

                    let zip = new AdmZip(to)
                    let zipEntries = zip.getEntries()

                    // Unzip the native zip.
                    for (let i = 0; i < zipEntries.length; i++) {
                        if (zipEntries[i].isDirectory) {
                            continue
                        }

                        const fileName = zipEntries[i].entryName

                        let shouldExclude = false

                        // Exclude noted files.
                        exclusionArr.forEach(function (exclusion) {
                            if (fileName.indexOf(exclusion) > -1) {
                                shouldExclude = true
                            }
                        })

                        const extractName = fileName.includes('/') ? fileName.substring(fileName.lastIndexOf('/')) : fileName

                        // Extract the file.
                        if (!shouldExclude) {
                            fs.writeFile(path.join(tempNativePath, extractName), zipEntries[i].getData(), (err) => {
                                if (err) {
                                    logger.error('Error while extracting native library:', err)
                                }
                            })
                        }

                    }
                }
                // No natives
                else {
                    const dlInfo = lib.downloads
                    const artifact = dlInfo.artifact
                    const to = path.join(this.libPath, artifact.path)
                    const versionIndependentId = lib.name.substring(0, lib.name.lastIndexOf(':'))
                    libs[versionIndependentId] = to
                }
            }
        }

        return libs
    }

    /**
     * Resolve the libraries declared by this server in order to add them to the classpath.
     * This method will also check each enabled mod for libraries, as mods are permitted to
     * declare libraries.
     *
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @returns {{[id: string]: string}} An object containing the paths of each library this server requires.
     */
    _resolveServerLibraries(mods) {
        const mdls = this.server.modules
        let libs = {}

        // Locate Forge/Libraries
        for (let mdl of mdls) {
            const type = mdl.rawModule.type
            if (type === Type.ForgeHosted || type === Type.Library) {
                libs[mdl.getVersionlessMavenIdentifier()] = mdl.getPath()
                if (mdl.subModules.length > 0) {
                    const res = this._resolveModuleLibraries(mdl)
                    if (res.length > 0) {
                        libs = {...libs, ...res}
                    }
                }
            }
        }

        //Check for any libraries in our mod list.
        for (let i = 0; i < mods.length; i++) {
            if (mods.sub_modules != null) {
                const res = this._resolveModuleLibraries(mods[i])
                if (res.length > 0) {
                    libs = {...libs, ...res}
                }
            }
        }

        return libs
    }

    /**
     * Recursively resolve the path of each library required by this module.
     *
     * @param {Object} mdl A module object from the server distro index.
     * @returns {Array.<string>} An array containing the paths of each library this module requires.
     */
    _resolveModuleLibraries(mdl) {
        if (!mdl.subModules.length > 0) {
            return []
        }
        let libs = []
        for (let sm of mdl.subModules) {
            if (sm.rawModule.type === Type.Library) {

                if (sm.rawModule.classpath ?? true) {
                    libs.push(sm.getPath())
                }
            }
            // If this module has submodules, we need to resolve the libraries for those.
            // To avoid unnecessary recursive calls, base case is checked here.
            if (mdl.subModules.length > 0) {
                const res = this._resolveModuleLibraries(sm)
                if (res.length > 0) {
                    libs = libs.concat(res)
                }
            }
        }
        return libs
    }

    static isAutoconnectBroken(forgeVersion) {

        const minWorking = [31, 2, 15]
        const verSplit = forgeVersion.split('.').map(v => Number(v))

        if (verSplit[0] === 31) {
            for (let i = 0; i < minWorking.length; i++) {
                if (verSplit[i] > minWorking[i]) {
                    return false
                } else if (verSplit[i] < minWorking[i]) {
                    return true
                }
            }
        }

        return false
    }

}

module.exports = ProcessBuilder
