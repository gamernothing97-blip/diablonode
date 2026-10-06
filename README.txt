KVM panel - NODE ONLY package
=============================
1. In the panel: Administration > Nodes > (your node) > Configuration > "Generate configuration". Copy the token (knode_...).
2. Upload this zip to the node server (Debian/Ubuntu), then:
     unzip kvmpanel-node.zip && cd kvmpanel-node
     sudo bash install-node.sh --panel https://YOUR-PANEL-ADDRESS --token knode_XXXX
3. Check:  systemctl status kvmpanel-node   |   journalctl -u kvmpanel-node -n 30
The node should show Online in the panel within a few seconds.

OS images
---------
The installer also downloads all supported OS images (Ubuntu 24.04/22.04, Debian 12, AlmaLinux 9,
CentOS Stream 9, Fedora 42) into /var/lib/kvmpanel-node/templates. That is a few GB.
  Skip them:        ... --os none
  Only some:        ... --os ubuntu-24.04,debian-12
  Add later:        sudo bash /opt/kvmpanel-node/install-os.sh debian-12
  List names:       bash install-os.sh --list
They show as ready for this node in the panel under OS templates within a few seconds.
If a vendor moves a file, that one fails and the rest continue; set a new URL in the panel.
