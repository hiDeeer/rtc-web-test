import { io } from 'socket.io-client';

const { RTCPeerConnection, RTCSessionDescription } = window;

function capitalizeFirstLetter(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

class PeerConnectionSession {
  _onConnected;
  _onDisconnected;
  _room;
  peerConnections = {};
  senders = [];
  listeners = {};

  constructor(socket) {
    this.socket = socket;
    this.onCallMade();
    this.onAnswerMade();
    this.onAddUser();
    this.onRemoveUser();
    this.onUpdateUserList();
  }

  addPeerConnection(id, stream, callback) {
    this.peerConnections[id] = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    // Add local stream tracks to the peer connection
    stream.getTracks().forEach((track) => {
      this.senders.push(this.peerConnections[id].addTrack(track, stream));
    });

    // Listener for connection state changes
    this.listeners[id] = (event) => {
      const fn = this['_on' + capitalizeFirstLetter(this.peerConnections[id].connectionState)];
      fn && fn(event, id);
    };

    this.peerConnections[id].addEventListener('connectionstatechange', this.listeners[id]);

    // Listen for incoming tracks
    this.peerConnections[id].ontrack = ({ streams: [stream] }) => {
      console.log({ id, stream });
      callback(stream); // Callback to handle the received stream
    };

    console.log(this.peerConnections);
  }

  removePeerConnection(id) {
    if (this.peerConnections[id]) {
      this.peerConnections[id].removeEventListener('connectionstatechange', this.listeners[id]);
      this.peerConnections[id].close(); // Close the peer connection
      delete this.peerConnections[id];
      delete this.listeners[id];
    }
  }

  async callUser(to) {
    if (!this.peerConnections[to]) return; // Ensure the peer connection exists

    if (this.peerConnections[to].iceConnectionState === 'new') {
      const offer = await this.peerConnections[to].createOffer();
      await this.peerConnections[to].setLocalDescription(new RTCSessionDescription(offer));

      this.socket.emit('call-user', { offer, to });
    }
  }

  joinRoom(room) {
    this._room = room;
    this.socket.emit('joinRoom', room);
  }

  onCallMade() {
    this.socket.on('call-made', async (data) => {
      await this.addPeerConnection(data.socket, new MediaStream(), (stream) => {
        // Handle incoming stream (e.g., display it in the UI)
      });

      await this.peerConnections[data.socket].setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await this.peerConnections[data.socket].createAnswer();
      await this.peerConnections[data.socket].setLocalDescription(new RTCSessionDescription(answer));

      this.socket.emit('make-answer', {
        answer,
        to: data.socket,
      });
    });
  }

  onAnswerMade() {
    this.socket.on('answer-made', async (data) => {
      await this.peerConnections[data.socket].setRemoteDescription(new RTCSessionDescription(data.answer));
    });
  }

  onAddUser(callback) {
    this.socket.on(`${this._room}-add-user`, async ({ user }) => {
      callback(user);
    });
  }

  onRemoveUser(callback) {
    this.socket.on(`${this._room}-remove-user`, ({ socketId }) => {
      callback(socketId);
    });
  }

  onUpdateUserList(callback) {
    this.socket.on(`${this._room}-update-user-list`, ({ users, current }) => {
      callback(users, current);
    });
  }

  clearConnections() {
    this.socket.disconnect(); // Disconnect the socket
    this.senders = [];
    Object.keys(this.peerConnections).forEach(this.removePeerConnection.bind(this));
  }
}

export const createPeerConnectionContext = () => {
  const socket = io("http://localhost:3000"); // Ensure the namespace matches your server setup
  return new PeerConnectionSession(socket);
};
