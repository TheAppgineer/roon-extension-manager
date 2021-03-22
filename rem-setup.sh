#!/bin/bash

NAME=rem
VERSION=1.0.0-beta2

OK="[ \e[32mOK\e[0m ]"
FAIL="[\e[31mFAIL\e[0m]"

#        |       |       |       |       |       |
CHK_ROOT='Checking for root privileges...\t\t'
UNINSTAL='Performing uninstall...\t\t\t'
CHK_DOCK='Checking for Docker socket...\t\t'
ADD_USER='Adding user to docker group...\t\t'
RM_LEGCY='Removing old installation...\t\t'
DL_SCRPT='Downloading shell script...\t\t'
DTECT_TZ='Detecting timezone...\t\t\t'
SETUP_SV='Setting up service...\t\t\t'
START_SV='Starting service...\t\t\t'
WAIT_VOL='Waiting for volume creation...\t\t'
SET_UDEV='Setting udev rule for CD Ripper...\t'

echo Roon Extension Manager setup script - version $VERSION
echo

if [ "$1" = "--version" ]; then
    exit 0
fi

# Check for root privileges
echo -ne $CHK_ROOT
USR=$(env | grep SUDO_USER | cut -d= -f 2)

if [ -z "$USR" ]; then
    USR=`whoami`

    if [ "$USR" != "root" ]; then
        echo -e $FAIL
        exit 1
    fi
fi
echo -e $OK

ROOT_DIR=$(eval echo ~$USR)/.$NAME

if [ "$1" = "--uninstall" ]; then
    # Perform uninstall
    echo -ne $UNINSTAL

    # Remove service
    systemctl --quiet stop $NAME
    systemctl --quiet disable $NAME
    rm -f /etc/systemd/system/$NAME.service
    rm -f /etc/udev/rules.d/80-audio-cd.rules

    # Remove files
    rm -rf "$ROOT_DIR"

    echo -e $OK
    exit 0
fi

# Check for Docker socket
echo -ne $CHK_DOCK
GRP=$(stat -c '%G' /var/run/docker.sock)
GID=$(stat -c '%g' /var/run/docker.sock)

if [ $? -gt 0 ]; then
    echo -e $FAIL
    exit 1
fi
echo -e $OK

if [ $USR != "root" ]; then
    groups $USR | grep $GRP > /dev/null 2>&1
    if [ $? -gt 0 ]; then
        # Add user to docker group
        echo -ne $ADD_USER
        usermod -aG docker $USR
        echo -e $OK
    fi
fi

# if [ -d $HOME/.RoonExtensions ]; then
#     # Remove old installation
#     echo -ne $RM_LEGCY
#
#     su -c "wget -q https://raw.githubusercontent.com/TheAppgineer/roon-extension-manager-packaging/master/linux/setup.sh" $USR
#     if [ $? -gt 0 ]; then
#         echo -e $FAIL
#         exit 1
#     else
#         chmod +x setup.sh
#         ./setup.sh --uninstall > /dev/null 2>&1
#         rm setup.sh
#         echo -e $OK
#     fi
# fi

if [ -f "/etc/systemd/system/roon-extension-manager.service" ]; then
    # Only disable the v0.x service for the moment, so that the user can switch back and forth
    systemctl --quiet stop roon-extension-manager
    systemctl --quiet disable roon-extension-manager
fi

su -c "mkdir -p $ROOT_DIR" $USR

if [ ! -f "$NAME.sh" ]; then
    # Download shell script
    echo -ne $DL_SCRPT
    su -c "wget -q https://raw.githubusercontent.com/TheAppgineer/roon-extension-manager/v1.x/$NAME.sh" $USR
    if [ $? -gt 0 ]; then
        echo -e $FAIL
        exit 1
    fi

    chmod +x $NAME.sh
    mv $NAME.sh $ROOT_DIR
    echo -e $OK
else
    chmod +x $NAME.sh
    su -c "cp $NAME.sh $ROOT_DIR" $USR
fi

if [ ! -f "/etc/systemd/system/$NAME.service" ]; then
    if [ -z "$TZ" ]; then
        # Detect timezone
        echo -ne $DTECT_TZ

        timedatectl > /dev/null 2>&1
        if [ $? -eq 0 ]; then
            TZ=$(timedatectl | sed -n 's/^\s*Time zone: \(.*\) (.*/\1/p')
            echo -e $OK
        elif [ -f /etc/timezone ]; then
            TZ=$(cat /etc/timezone)
            echo -e $OK
        else
            TZ=""
            echo -e $FAIL
        fi
    fi

    # Set up service
    echo -ne $SETUP_SV

    # Create service file
    cat << EOF > $NAME.service
[Unit]
Description=Roon Extension Manager
Requires=docker.service
After=docker.service

[Service]
User=$USR
Restart=always
ExecStart=$ROOT_DIR/$NAME.sh
Environment="DOCKER_GID=$GID"
Environment="TZ=$TZ"

[Install]
WantedBy=multi-user.target
EOF

    # Configure service
    mv $NAME.service /etc/systemd/system/
    if [ $? -gt 0 ]; then
        echo -e $FAIL
        exit 1
    fi
    systemctl --quiet daemon-reload

    echo -e $OK
fi

# Start service
echo -ne $START_SV

systemctl --quiet enable $NAME
systemctl --quiet start $NAME

echo -e $OK

# Wait for volume creation
echo -ne $WAIT_VOL

until docker volume inspect rem_data > /dev/null 2>&1; do
    sleep 1s
done
echo -e $OK

if [ ! -f "/etc/udev/rules.d/80-audio-cd.rules" ]; then
    # Set udev rule for CD Ripper
    echo -ne $SET_UDEV

    mkdir -p /etc/udev/rules.d/
    VOLUME=$(docker volume inspect -f {{.Mountpoint}} rem_data)

    echo "SUBSYSTEM==\"block\", SUBSYSTEMS==\"scsi\", KERNEL==\"sr?\", ENV{ID_TYPE}==\"cd\", ENV{ID_CDROM}==\"?*\", ENV{ID_CDROM_MEDIA_TRACK_COUNT_AUDIO}==\"?*\", ACTION==\"change\", RUN+=\"/bin/su -lc 'echo 1 > $VOLUME/binds/roon-extension-cd-ripper/root/inserted' root\"" > /etc/udev/rules.d/80-audio-cd.rules
    if [ $? -gt 0 ]; then
        echo -e $FAIL
    else
        udevadm control --reload-rules && udevadm trigger
        echo -e $OK
    fi
fi

echo
echo "Roon Extension Manager installed successfully!"
echo "Select Settings->Extensions on your Roon Remote to manage your extensions."
echo
