# roon-extension-manager

Roon Extension for managing Roon Extensions.

------------

## Installation

1. Install Node.js from https://nodejs.org.

   * On Windows, install from the above link.
   * On Mac OS, you can use [homebrew](http://brew.sh) to install Node.js.
   * On Linux, you can use your distribution's package manager, but make sure it installs a recent Node.js. Otherwise just install from the above link.

   Make sure you are running node 5.x or higher. This can be verified on the command line with the following command:

   ```
   node -v
   ```

   For example:

   ```
   $ node -v
   v5.10.1
   ```

1. Install Git from https://git-scm.com/downloads.

   * Following the instructions for the Operating System you are running.

1. Setup an extension installation location via npm.

   * Make a global extension directory:
     ```
     mkdir ~/.RoonExtensions
     ```
   * Configure npm to use the new directory path:
     ```
     npm config set prefix '~/.RoonExtensions'
     ```

   Note: If you use npm for other purposes as well, it may be handy to use an environment variable instead. Background information about setting up a global npm installation directory can be found [here](https://docs.npmjs.com/getting-started/fixing-npm-permissions#option-2-change-npms-default-directory-to-another-directory).

1. Install the extension at the set location:
    ```
    npm install -g https://github.com/TheAppgineer/roon-extension-manager.git
    ```

1. Run it!
    ```
    cd ~/.RoonExtensions/lib/node_modules/roon-extension-manager
    node start.js
    ```

    The extension should appear in Roon now. See Settings->Extensions. If you have multiple Roon Cores on the network, all of them should see it but only one can connect at a time.

## Notes
* Remember that extensions are installed on the device at which the Extension Manager is running (hostname is included in the extension name to differentiate between multiple devices).
* Automatic startup at system start is OS dependent and outside the scope of this document.
